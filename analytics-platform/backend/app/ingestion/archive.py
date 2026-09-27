"""Safe extraction of compressed uploads: .gz, .zip, .tar, .tar.gz (ING-006, SEC).

* The 1 GB dataset limit applies to the **uncompressed** size. It is checked
  against the sizes the archive declares and again while streaming, because
  headers can lie.
* Zip bombs are rejected: an overall compression ratio above 100:1 (once more
  than 1 MiB has been produced, so tiny files of repeated text still pass).
* Members with absolute paths, ``..`` components, links or device entries are
  rejected (path traversal); directories and OS metadata (``__MACOSX/``,
  dot-files) are skipped. Members are written under generated names, never
  under their archive paths.
* Encrypted members and nested archives are not supported.
"""

from __future__ import annotations

import gzip
import re
import stat
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO

CHUNK = 1024 * 1024
MAX_RATIO = 100
BOMB_MIN_BYTES = 1024 * 1024
MAX_MEMBERS = 100


class ArchiveError(ValueError):
    """The archive is malformed, unsafe or too large."""


class ArchiveTooLarge(ArchiveError):
    pass


@dataclass
class ExtractedFile:
    name: str  # member path inside the archive (sanitized, for display and table naming)
    path: Path


def archive_kind(path: Path) -> str | None:
    """``zip`` | ``gzip`` | ``tar`` | None, from magic bytes. XLSX workbooks (also zips) are not archives."""
    with path.open("rb") as fh:
        head = fh.read(512)
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        try:
            with zipfile.ZipFile(path) as zf:
                if "[Content_Types].xml" in zf.namelist():
                    return None  # an Office Open XML document (.xlsx)
        except zipfile.BadZipFile as exc:
            raise ArchiveError(f"corrupt zip archive: {exc}") from exc
        return "zip"
    if head.startswith(b"\x1f\x8b"):
        return "gzip"
    if len(head) >= 262 and head[257:262] == b"ustar":
        return "tar"
    return None


def _safe_member_name(raw: str) -> str | None:
    """Validated member path, or None for entries that are skipped (directories, OS metadata)."""
    name = raw.replace("\\", "/")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ArchiveError(f"archive member {raw!r} has an absolute path")
    parts = PurePosixPath(name).parts
    if any(p == ".." for p in parts):
        raise ArchiveError(f"archive member {raw!r} escapes the archive (path traversal)")
    if name.endswith("/") or not parts:
        return None
    if parts[0] == "__MACOSX" or any(p.startswith(".") for p in parts):
        return None
    return "/".join(p for p in parts if p not in ("", "."))


class _Budget:
    """Tracks uncompressed bytes against the size limit and the compression ratio."""

    def __init__(self, compressed_size: int, max_bytes: int):
        self.compressed = max(1, compressed_size)
        self.max_bytes = max_bytes
        self.total = 0

    def check_declared(self, declared: int) -> None:
        if declared > self.max_bytes:
            raise ArchiveTooLarge(f"archive expands to {declared:,} bytes, over the {self.max_bytes / 1024**3:.0f} GB limit")
        self._ratio(declared)

    def add(self, n: int) -> None:
        self.total += n
        if self.total > self.max_bytes:
            raise ArchiveTooLarge(f"archive expands beyond the {self.max_bytes / 1024**3:.0f} GB limit (uncompressed)")
        self._ratio(self.total)

    def _ratio(self, uncompressed: int) -> None:
        if uncompressed > BOMB_MIN_BYTES and uncompressed / self.compressed > MAX_RATIO:
            raise ArchiveError(f"compression ratio above {MAX_RATIO}:1 — rejected as a possible zip bomb")


def _copy(src: BinaryIO, dst: Path, budget: _Budget) -> None:
    with dst.open("wb") as out:
        while chunk := src.read(CHUNK):
            budget.add(len(chunk))
            out.write(chunk)


def _unique_path(out_dir: Path, index: int, name: str) -> Path:
    suffix = "".join(PurePosixPath(name).suffixes[-2:])[:20]
    suffix = re.sub(r"[^A-Za-z0-9.]", "", suffix)
    return out_dir / f"member-{index:03d}{suffix}"


def _extract_zip(path: Path, out_dir: Path, budget: _Budget) -> list[ExtractedFile]:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise ArchiveError(f"corrupt zip archive: {exc}") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MEMBERS * 4:
            raise ArchiveError(f"archive has too many entries ({len(infos)})")
        wanted: list[tuple[zipfile.ZipInfo, str]] = []
        for info in infos:
            name = _safe_member_name(info.filename)
            if name is None or info.is_dir():
                continue
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or (mode and not stat.S_ISREG(mode) and stat.S_IFMT(mode)):
                raise ArchiveError(f"archive member {info.filename!r} is a link or special file")
            if info.flag_bits & 0x1:
                raise ArchiveError(f"archive member {info.filename!r} is encrypted")
            wanted.append((info, name))
        if len(wanted) > MAX_MEMBERS:
            raise ArchiveError(f"archive has more than {MAX_MEMBERS} files")
        budget.check_declared(sum(i.file_size for i, _ in wanted))
        out: list[ExtractedFile] = []
        for index, (info, name) in enumerate(wanted):
            target = _unique_path(out_dir, index, name)
            try:
                with zf.open(info) as src:
                    _copy(src, target, budget)
            except (zipfile.BadZipFile, EOFError, OSError) as exc:
                if isinstance(exc, ArchiveError):
                    raise
                raise ArchiveError(f"could not extract {name!r}: {exc}") from exc
            out.append(ExtractedFile(name=name, path=target))
        return out


def _extract_tar(path: Path, out_dir: Path, budget: _Budget, *, count_bytes: bool = True) -> list[ExtractedFile]:
    try:
        tf = tarfile.open(path, mode="r:*")
    except tarfile.TarError as exc:
        raise ArchiveError(f"corrupt tar archive: {exc}") from exc
    out: list[ExtractedFile] = []
    with tf:
        for index, member in enumerate(tf):
            if index >= MAX_MEMBERS * 4:
                raise ArchiveError("archive has too many entries")
            name = _safe_member_name(member.name)
            if member.issym() or member.islnk() or member.isdev() or member.ischr() or member.isblk() or member.isfifo():
                raise ArchiveError(f"archive member {member.name!r} is a link or special file")
            if name is None or member.isdir() or not member.isfile():
                continue
            if len(out) >= MAX_MEMBERS:
                raise ArchiveError(f"archive has more than {MAX_MEMBERS} files")
            if member.size > budget.max_bytes:
                raise ArchiveTooLarge(f"archive member {name!r} is over the {budget.max_bytes / 1024**3:.0f} GB limit")
            src = tf.extractfile(member)
            if src is None:  # pragma: no cover - regular files always have data
                continue
            target = _unique_path(out_dir, len(out), name)
            if count_bytes:
                _copy(src, target, budget)
            else:
                with target.open("wb") as fh:
                    while chunk := src.read(CHUNK):
                        fh.write(chunk)
            out.append(ExtractedFile(name=name, path=target))
    return out


def extract(path: Path, filename: str, out_dir: Path, *, max_bytes: int) -> tuple[str | None, list[ExtractedFile]]:
    """Extract an archive upload. Returns (kind, files); kind None means ``path`` is not an archive."""
    kind = archive_kind(path)
    if kind is None:
        return None, []
    out_dir.mkdir(parents=True, exist_ok=True)
    budget = _Budget(path.stat().st_size, max_bytes)
    if kind == "zip":
        files = _extract_zip(path, out_dir, budget)
    elif kind == "tar":
        files = _extract_tar(path, out_dir, budget)
    else:
        inner = re.sub(r"\.(gz|gzip)$", "", Path(filename.replace("\\", "/")).name, flags=re.IGNORECASE) or "data"
        if filename.lower().endswith(".tgz"):
            inner = inner[:-4] + ".tar"
        target = out_dir / "gunzipped"
        try:
            with gzip.open(path, "rb") as src:
                _copy(src, target, budget)
        except (OSError, EOFError, gzip.BadGzipFile) as exc:
            if isinstance(exc, ArchiveError):
                raise
            raise ArchiveError(f"corrupt gzip file: {exc}") from exc
        if archive_kind(target) == "tar" or inner.lower().endswith(".tar"):
            kind = "tar.gz"
            # Bytes were already counted (and ratio-checked) while decompressing.
            files = _extract_tar(target, out_dir, budget, count_bytes=False)
            target.unlink(missing_ok=True)
        else:
            if archive_kind(target) is not None:
                raise ArchiveError("nested archives are not supported")
            files = [ExtractedFile(name=_safe_member_name(inner) or "data", path=target)]
    if not files:
        raise ArchiveError("archive contains no data files")
    for f in files:
        if archive_kind(f.path) is not None:
            raise ArchiveError(f"nested archive {f.name!r} is not supported; extract it first")
    return kind, files
