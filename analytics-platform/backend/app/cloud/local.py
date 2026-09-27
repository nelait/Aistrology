"""Single-machine implementations for development, tests and demos (AP_CLOUD_PROVIDER=local)."""

from __future__ import annotations

import json
import os
import queue as stdqueue
import shutil
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .base import KeyManager, ObjectNotFound, ObjectStore, Queue, QueueMessage, SecretStore


class LocalObjectStore(ObjectStore):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if path != self.root and self.root not in path.parents:
            raise ValueError("object key escapes the storage root")
        return path

    def put_file(self, key: str, path: Path) -> None:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}")
        shutil.copyfile(path, tmp)
        tmp.replace(dest)

    def put_bytes(self, key: str, data: bytes) -> None:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}")
        tmp.write_bytes(data)
        tmp.replace(dest)

    def get_bytes(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError as exc:
            raise ObjectNotFound(key) from exc

    def download(self, key: str, path: Path) -> None:
        src = self._path(key)
        if not src.exists():
            raise ObjectNotFound(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, path)

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def list(self, prefix: str) -> Iterator[tuple[str, int]]:
        base = self._path(prefix.rsplit("/", 1)[0]) if "/" in prefix else self.root
        if not base.exists():
            return
        for path in sorted(base.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                key = path.relative_to(self.root).as_posix()
                if key.startswith(prefix):
                    yield key, path.stat().st_size

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class LocalKeyManager(KeyManager):
    """AES-256-GCM key wrapping with a master key file. Stands in for Cloud KMS / AWS KMS."""

    def __init__(self, master_key_path: Path):
        master_key_path.parent.mkdir(parents=True, exist_ok=True)
        if not master_key_path.exists():
            fd = os.open(master_key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as fh:
                fh.write(AESGCM.generate_key(bit_length=256))
        self._aes = AESGCM(master_key_path.read_bytes())

    def wrap(self, tenant_id: str, plaintext_key: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aes.encrypt(nonce, plaintext_key, tenant_id.encode())

    def unwrap(self, tenant_id: str, wrapped_key: bytes) -> bytes:
        return self._aes.decrypt(wrapped_key[:12], wrapped_key[12:], tenant_id.encode())


class LocalSecretStore(SecretStore):
    """Secrets in a JSON file, each value encrypted with the local master key and bound to its tenant and name."""

    def __init__(self, path: Path, kms: LocalKeyManager):
        self.path = path
        self.kms = kms
        self._lock = threading.Lock()

    def _load(self) -> dict[str, str]:
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def _save(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    @staticmethod
    def _id(tenant_id: str, name: str) -> str:
        return f"{tenant_id}/{name}"

    def put(self, tenant_id: str, name: str, value: str) -> None:
        with self._lock:
            data = self._load()
            data[self._id(tenant_id, name)] = self.kms.wrap(self._id(tenant_id, name), value.encode()).hex()
            self._save(data)

    def get(self, tenant_id: str, name: str) -> str | None:
        blob = self._load().get(self._id(tenant_id, name))
        return None if blob is None else self.kms.unwrap(self._id(tenant_id, name), bytes.fromhex(blob)).decode()

    def delete(self, tenant_id: str, name: str) -> None:
        with self._lock:
            data = self._load()
            data.pop(self._id(tenant_id, name), None)
            self._save(data)

    def names(self, tenant_id: str) -> list[str]:
        prefix = f"{tenant_id}/"
        return sorted(k[len(prefix) :] for k in self._load() if k.startswith(prefix))


class InMemoryQueue(Queue):
    """In-process queue with redelivery on nack. Good for local mode and tests."""

    def __init__(self) -> None:
        self._q: stdqueue.Queue[tuple[str, dict]] = stdqueue.Queue()

    def publish(self, body: dict) -> str:
        message_id = uuid.uuid4().hex
        self._q.put((message_id, body))
        return message_id

    def receive(self, max_messages: int = 1, wait_seconds: float = 10.0) -> list[QueueMessage]:
        out: list[QueueMessage] = []
        try:
            message_id, body = self._q.get(timeout=wait_seconds) if wait_seconds > 0 else self._q.get_nowait()
            out.append(QueueMessage(id=message_id, body=body, receipt=message_id))
            while len(out) < max_messages:
                message_id, body = self._q.get_nowait()
                out.append(QueueMessage(id=message_id, body=body, receipt=message_id))
        except stdqueue.Empty:
            pass
        return out

    def ack(self, message: QueueMessage) -> None:
        return None

    def nack(self, message: QueueMessage) -> None:
        self._q.put((message.id, message.body))

    def qsize(self) -> int:
        return self._q.qsize()
