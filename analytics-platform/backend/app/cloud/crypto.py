"""Per-tenant envelope encryption for objects (SEC-001, SOC-CON-004).

Each tenant has one random 256-bit data key (DEK). The DEK is stored only in
wrapped form (encrypted by the cloud KMS master key, bound to the tenant ID),
next to the tenant's data. Deleting the wrapped DEK makes every object of that
tenant unreadable: crypto-shredding, even for copies left in backups.

Object format (chunked AES-256-GCM, so 1 GB files stream in bounded memory):

    b"APE1" | nonce_prefix (8 bytes) | { u32 chunk_len | ciphertext+tag } ...

Chunk ``i`` uses nonce ``nonce_prefix || u32(i)``. Its AAD is the object key plus
the chunk index plus a final-chunk flag, so chunks can't be reordered, truncated
or moved to another key.
"""

from __future__ import annotations

import os
import struct
import threading
from collections.abc import Iterator
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .base import KeyManager, ObjectNotFound, ObjectStore

MAGIC = b"APE1"
CHUNK = 4 * 1024 * 1024
TAG = 16


class DecryptionError(ValueError):
    pass


class TenantKeyShredded(PermissionError):
    pass


def _aad(key: str, index: int, final: bool) -> bytes:
    return key.encode() + struct.pack(">I?", index, final)


def encrypt_stream(dek: bytes, object_key: str, chunks: Iterator[bytes]) -> Iterator[bytes]:
    aes = AESGCM(dek)
    prefix = os.urandom(8)
    yield MAGIC + prefix
    index = 0
    pending: bytes | None = None
    buffer = b""
    for data in chunks:
        buffer += data
        while len(buffer) >= CHUNK:
            if pending is not None:
                yield _seal(aes, prefix, index, object_key, pending, final=False)
                index += 1
            pending, buffer = buffer[:CHUNK], buffer[CHUNK:]
    # Flush: whatever is pending plus the remainder; the last chunk carries final=True.
    if pending is not None and buffer:
        yield _seal(aes, prefix, index, object_key, pending, final=False)
        index += 1
        pending = buffer
    elif pending is None:
        pending = buffer
    yield _seal(aes, prefix, index, object_key, pending, final=True)


def _seal(aes: AESGCM, prefix: bytes, index: int, key: str, plaintext: bytes, *, final: bool) -> bytes:
    ct = aes.encrypt(prefix + struct.pack(">I", index), plaintext, _aad(key, index, final))
    return struct.pack(">I", len(ct)) + ct


def decrypt_stream(dek: bytes, object_key: str, data: Iterator[bytes]) -> Iterator[bytes]:
    aes = AESGCM(dek)
    buffer = b""
    header_done = False
    prefix = b""
    index = 0
    frames: list[bytes] = []

    for piece in data:
        buffer += piece
        if not header_done:
            if len(buffer) < 12:
                continue
            if buffer[:4] != MAGIC:
                raise DecryptionError("not an encrypted platform object")
            prefix, buffer, header_done = buffer[4:12], buffer[12:], True
        while len(buffer) >= 4:
            (length,) = struct.unpack(">I", buffer[:4])
            if len(buffer) < 4 + length:
                break
            frames.append(buffer[4 : 4 + length])
            buffer = buffer[4 + length :]
            # Hold back one frame: only the last frame may carry final=True.
            while len(frames) > 1:
                yield _open(aes, prefix, index, object_key, frames.pop(0), final=False)
                index += 1
    if not header_done or buffer or len(frames) != 1:
        raise DecryptionError("object is truncated or corrupt")
    yield _open(aes, prefix, index, object_key, frames[0], final=True)


def _open(aes: AESGCM, prefix: bytes, index: int, key: str, ct: bytes, *, final: bool) -> bytes:
    try:
        return aes.decrypt(prefix + struct.pack(">I", index), ct, _aad(key, index, final))
    except Exception as exc:  # cryptography raises InvalidTag
        raise DecryptionError("object failed authentication (wrong tenant key, tampered or truncated)") from exc


def _file_chunks(path: Path, size: int = CHUNK) -> Iterator[bytes]:
    with path.open("rb") as fh:
        while chunk := fh.read(size):
            yield chunk


class TenantKeyring:
    """Creates, caches, unwraps and shreds per-tenant DEKs. Wrapped DEKs live in the object store."""

    def __init__(self, objects: ObjectStore, kms: KeyManager):
        self.objects = objects
        self.kms = kms
        self._cache: dict[str, bytes] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key_path(tenant_id: str) -> str:
        return f"keys/{tenant_id}/dek.wrapped"

    def dek(self, tenant_id: str, *, create: bool = True) -> bytes:
        with self._lock:
            if tenant_id in self._cache:
                return self._cache[tenant_id]
            path = self.key_path(tenant_id)
            try:
                wrapped = self.objects.get_bytes(path)
                dek = self.kms.unwrap(tenant_id, wrapped)
            except ObjectNotFound:
                if not create:
                    raise TenantKeyShredded(f"no data key for tenant {tenant_id}") from None
                dek = AESGCM.generate_key(bit_length=256)
                self.objects.put_bytes(path, self.kms.wrap(tenant_id, dek))
            self._cache[tenant_id] = dek
            return dek

    def shred(self, tenant_id: str) -> None:
        """SOC-CON-004: destroy the tenant's DEK. Their data becomes unrecoverable."""
        with self._lock:
            self._cache.pop(tenant_id, None)
            self.objects.delete(self.key_path(tenant_id))


class EncryptedObjectStore:
    """Tenant-aware facade over an ObjectStore that encrypts everything under ``tenants/{id}/``."""

    def __init__(self, objects: ObjectStore, keyring: TenantKeyring):
        self.objects = objects
        self.keyring = keyring

    @staticmethod
    def _key(tenant_id: str, key: str) -> str:
        if ".." in key.split("/") or key.startswith("/"):
            raise ValueError("invalid object key")
        return f"tenants/{tenant_id}/{key}"

    def put_file(self, tenant_id: str, key: str, path: Path, scratch: Path) -> int:
        """Encrypt ``path`` to a scratch file and upload it. Returns the stored size."""
        full = self._key(tenant_id, key)
        dek = self.keyring.dek(tenant_id)
        scratch.parent.mkdir(parents=True, exist_ok=True)
        with scratch.open("wb") as out:
            for block in encrypt_stream(dek, full, _file_chunks(path)):
                out.write(block)
        try:
            self.objects.put_file(full, scratch)
            return scratch.stat().st_size
        finally:
            scratch.unlink(missing_ok=True)

    def put_bytes(self, tenant_id: str, key: str, data: bytes) -> None:
        full = self._key(tenant_id, key)
        self.objects.put_bytes(full, b"".join(encrypt_stream(self.keyring.dek(tenant_id), full, iter([data]))))

    def get_bytes(self, tenant_id: str, key: str) -> bytes:
        full = self._key(tenant_id, key)
        blob = self.objects.get_bytes(full)
        return b"".join(decrypt_stream(self.keyring.dek(tenant_id, create=False), full, iter([blob])))

    def download(self, tenant_id: str, key: str, path: Path) -> None:
        full = self._key(tenant_id, key)
        dek = self.keyring.dek(tenant_id, create=False)
        path.parent.mkdir(parents=True, exist_ok=True)
        encrypted = path.with_name(path.name + ".enc")
        tmp = path.with_name(path.name + ".part")
        try:
            self.objects.download(full, encrypted)
            with tmp.open("wb") as out:
                for block in decrypt_stream(dek, full, _file_chunks(encrypted)):
                    out.write(block)
            tmp.replace(path)
        finally:
            encrypted.unlink(missing_ok=True)
            tmp.unlink(missing_ok=True)

    def exists(self, tenant_id: str, key: str) -> bool:
        return self.objects.exists(self._key(tenant_id, key))

    def list(self, tenant_id: str, prefix: str = "") -> Iterator[tuple[str, int]]:
        base = self._key(tenant_id, "")
        for key, size in self.objects.list(self._key(tenant_id, prefix)):
            yield key[len(base) :], size

    def delete(self, tenant_id: str, key: str) -> None:
        self.objects.delete(self._key(tenant_id, key))

    def delete_tenant(self, tenant_id: str) -> int:
        """Delete every object of the tenant and shred its key (MT-010)."""
        count = self.objects.delete_prefix(f"tenants/{tenant_id}/")
        self.keyring.shred(tenant_id)
        return count
