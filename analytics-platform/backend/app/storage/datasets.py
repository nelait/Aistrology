"""Tenant-scoped, versioned dataset storage (ING-005/009/010, MT-001/006/007, PIP-007, ANA-NFR-002).

* Metadata (datasets, immutable versions, schema, profile) lives in the metadata DB.
* Files live in the configured object store (local disk, GCS or S3) under
  ``tenants/{tenant}/datasets/{id}/v{n}/...``, encrypted with the tenant's key.
* DuckDB and pandas need local files, so reads go through a decrypted cache on
  local scratch disk. The cache is disposable and rebuilt on demand, and the
  plaintext SHA-256 is verified on every download (SOC-PI-002).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..cloud.crypto import EncryptedObjectStore
from ..config import settings
from ..db.models import Dataset, DatasetVersion
from ..db.session import Database
from ..ingestion.formats import DataFormat, UnsupportedFormatError, detect_encoding, detect_format, is_xlsx
from ..schema.model import Schema

TENANT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,62}$")
DATASET_ID_RE = re.compile(r"^ds_[0-9a-f]{32}$")
HEAD_BYTES = 64 * 1024


class DatasetTooLarge(ValueError):
    def __init__(self, limit: int):
        super().__init__(
            f"dataset exceeds the {limit / 1024**3:.0f} GB limit. Split the file, drop unused columns, "
            "or convert it to Parquet (usually 3-10x smaller than CSV)."
        )


class QuotaExceeded(ValueError):
    pass


class DatasetNotFound(LookupError):
    pass


class IntegrityError(RuntimeError):
    pass


class TableRecord(BaseModel):
    name: str
    file: str  # object key relative to the tenant prefix
    format: DataFormat
    encoding: str = "utf-8"
    size_bytes: int
    sha256: str  # of the plaintext
    original_filename: str | None = None
    row_count: int | None = None


class DatasetRecord(BaseModel):
    id: str
    tenant_id: str
    project_id: str | None = None
    name: str
    version: int = 1
    latest_version: int = 1
    parent_version: int | None = None
    pipeline_id: str | None = None
    source: str
    created_at: str
    created_by: str
    tables: list[TableRecord] = Field(default_factory=list)
    schema_: Schema | None = Field(default=None, alias="schema")
    size_bytes: int = 0

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


def _safe_filename(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")) or "upload"
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)[:120]


def _table_name(filename: str) -> str:
    stem = Path(filename).stem.lower()
    stem = re.sub(r"[^a-z0-9_]", "_", stem).strip("_") or "data"
    return f"t_{stem}" if stem[0].isdigit() else stem


def _check_tenant(tenant_id: str) -> None:
    if not TENANT_ID_RE.match(tenant_id):
        raise ValueError("invalid tenant id")


def _to_record(ds: Dataset, v: DatasetVersion) -> DatasetRecord:
    return DatasetRecord(
        id=ds.id,
        tenant_id=ds.tenant_id,
        project_id=ds.project_id,
        name=ds.name,
        version=v.version,
        latest_version=ds.current_version,
        parent_version=v.parent_version,
        pipeline_id=v.pipeline_id,
        source=ds.source,
        created_at=(v.created_at if v.created_at.tzinfo else v.created_at.replace(tzinfo=UTC)).isoformat(),
        created_by=v.created_by,
        tables=[TableRecord.model_validate(t) for t in v.tables],
        schema_=Schema.model_validate(v.schema_json) if v.schema_json else None,
        size_bytes=v.size_bytes,
    )


class DatasetStore:
    def __init__(
        self,
        db: Database,
        objects: EncryptedObjectStore,
        cache_dir: Path,
        *,
        max_dataset_bytes: int | None = None,
        tenant_quota_bytes: int | None = None,
    ):
        self.db = db
        self.objects = objects
        self.cache_dir = cache_dir.resolve()
        self.max_dataset_bytes = max_dataset_bytes or settings.max_dataset_bytes
        self.tenant_quota_bytes = tenant_quota_bytes or settings.tenant_storage_quota_bytes

    # -- quota -----------------------------------------------------------
    def tenant_usage_bytes(self, tenant_id: str) -> int:
        with self.db.session(tenant_id) as s:
            total = s.execute(
                select(func.coalesce(func.sum(DatasetVersion.size_bytes), 0))
                .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
                .where(DatasetVersion.tenant_id == tenant_id, Dataset.deleted_at.is_(None))
            ).scalar_one()
        return int(total)

    def _check_quota(self, tenant_id: str, incoming: int) -> None:
        if self.tenant_usage_bytes(tenant_id) + incoming > self.tenant_quota_bytes:
            raise QuotaExceeded(f"tenant storage quota of {self.tenant_quota_bytes / 1024**3:.0f} GB would be exceeded")

    # -- paths -----------------------------------------------------------
    def _scratch(self, tenant_id: str) -> Path:
        path = self.cache_dir / "scratch" / tenant_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _cache_path(self, tenant_id: str, key: str) -> Path:
        path = (self.cache_dir / "cache" / tenant_id / key).resolve()
        if (self.cache_dir / "cache" / tenant_id).resolve() not in path.parents:
            raise PermissionError("cache path escapes the tenant directory")
        return path

    def table_path(self, record: DatasetRecord, table: TableRecord) -> Path:
        """Local plaintext copy of a table, downloaded, decrypted and verified if not cached."""
        path = self._cache_path(record.tenant_id, table.file)
        if path.exists():
            return path
        self.objects.download(record.tenant_id, table.file, path)
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != table.sha256:
            path.unlink(missing_ok=True)
            raise IntegrityError(f"checksum mismatch for {table.file}")
        return path

    # -- writes ----------------------------------------------------------
    def _store_file(self, tenant_id: str, key: str, local: Path) -> None:
        """Upload (encrypted) and keep the plaintext as the cache entry."""
        self.objects.put_file(tenant_id, key, local, self._scratch(tenant_id) / f"enc-{uuid.uuid4().hex}")
        cached = self._cache_path(tenant_id, key)
        cached.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(local), cached)

    def _insert(
        self,
        tenant_id: str,
        actor: str,
        *,
        dataset_id: str,
        name: str,
        source: str,
        tables: list[TableRecord],
        schema: Schema | None,
        version: int,
        parent_version: int | None = None,
        pipeline_id: str | None = None,
        pipeline_hash: str | None = None,
        project_id: str | None = None,
    ) -> DatasetRecord:
        with self.db.session(tenant_id) as s:
            ds = s.get(Dataset, dataset_id)
            if ds is None:
                ds = Dataset(id=dataset_id, tenant_id=tenant_id, name=name, source=source, created_by=actor, project_id=project_id)
                s.add(ds)
            ds.current_version = version
            v = DatasetVersion(
                tenant_id=tenant_id,
                dataset_id=dataset_id,
                version=version,
                parent_version=parent_version,
                pipeline_id=pipeline_id,
                pipeline_hash=pipeline_hash,
                tables=[t.model_dump(mode="json") for t in tables],
                schema_json=schema.model_dump(mode="json") if schema else None,
                size_bytes=sum(t.size_bytes for t in tables),
                created_by=actor,
            )
            s.add(v)
            s.flush()
            return _to_record(ds, v)

    async def save_upload(
        self,
        tenant_id: str,
        actor: str,
        filename: str,
        chunks: AsyncIterator[bytes],
        *,
        declared_size: int | None = None,
        expected_sha256: str | None = None,
        name: str | None = None,
        project_id: str | None = None,
    ) -> DatasetRecord:
        """Stream an upload to scratch disk, enforcing the size limit before and during the transfer (ING-NFR-004)."""
        _check_tenant(tenant_id)
        if declared_size is not None and declared_size > self.max_dataset_bytes:
            raise DatasetTooLarge(self.max_dataset_bytes)
        self._check_quota(tenant_id, declared_size or 0)
        digest = hashlib.sha256()
        size = 0
        head = b""
        fd, tmp_name = tempfile.mkstemp(dir=self._scratch(tenant_id), prefix=".upload-")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as out:
                async for chunk in chunks:
                    size += len(chunk)
                    if size > self.max_dataset_bytes:
                        raise DatasetTooLarge(self.max_dataset_bytes)
                    if len(head) < HEAD_BYTES:
                        head += chunk[: HEAD_BYTES - len(head)]
                    digest.update(chunk)
                    out.write(chunk)
            sha = digest.hexdigest()
            if expected_sha256 and expected_sha256.lower() != sha:
                raise ValueError("checksum mismatch: the file was corrupted in transit")
            if size == 0:
                raise ValueError("file is empty")
            fmt = detect_format(filename, head)
            if fmt == DataFormat.XLSX and not is_xlsx(tmp):
                raise UnsupportedFormatError("file is not a valid .xlsx workbook")
            encoding = detect_encoding(head) if fmt in (DataFormat.CSV, DataFormat.TSV, DataFormat.JSON, DataFormat.JSONL) else "binary"
            self._check_quota(tenant_id, size)
            safe = _safe_filename(filename)
            dataset_id = f"ds_{uuid.uuid4().hex}"
            key = f"datasets/{dataset_id}/v1/raw/{safe}"
            table = TableRecord(
                name=_table_name(safe),
                file=key,
                format=fmt,
                encoding=encoding,
                size_bytes=size,
                sha256=sha,
                original_filename=filename,
            )
            self._store_file(tenant_id, key, tmp)
            return self._insert(
                tenant_id,
                actor,
                dataset_id=dataset_id,
                name=name or Path(safe).stem,
                source="upload",
                tables=[table],
                schema=None,
                version=1,
                project_id=project_id,
            )
        finally:
            tmp.unlink(missing_ok=True)

    def save_frames(
        self,
        tenant_id: str,
        actor: str,
        name: str,
        frames: dict[str, pd.DataFrame],
        schema: Schema | None,
        *,
        source: str = "generated",
        dataset_id: str | None = None,
        pipeline_id: str | None = None,
        pipeline_hash: str | None = None,
        project_id: str | None = None,
    ) -> DatasetRecord:
        """Persist frames as Parquet. With ``dataset_id``, this creates the next immutable version of that dataset."""
        _check_tenant(tenant_id)
        parent: int | None = None
        if dataset_id is not None:
            current = self.get(tenant_id, dataset_id)
            parent, version, name, source = current.latest_version, current.latest_version + 1, current.name, current.source
        else:
            dataset_id, version = f"ds_{uuid.uuid4().hex}", 1
        tables: list[TableRecord] = []
        staged: list[tuple[str, Path]] = []
        try:
            for table, frame in frames.items():
                local = self._scratch(tenant_id) / f"{uuid.uuid4().hex}.parquet"
                pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), local)
                data = local.read_bytes()
                key = f"datasets/{dataset_id}/v{version}/tables/{table}.parquet"
                tables.append(
                    TableRecord(
                        name=table,
                        file=key,
                        format=DataFormat.PARQUET,
                        encoding="binary",
                        size_bytes=len(data),
                        sha256=hashlib.sha256(data).hexdigest(),
                        row_count=len(frame),
                    )
                )
                staged.append((key, local))
            size = sum(t.size_bytes for t in tables)
            if size > self.max_dataset_bytes:
                raise DatasetTooLarge(self.max_dataset_bytes)
            self._check_quota(tenant_id, size)
            for key, local in staged:
                self._store_file(tenant_id, key, local)
        finally:
            for _, local in staged:
                local.unlink(missing_ok=True)
        return self._insert(
            tenant_id,
            actor,
            dataset_id=dataset_id,
            name=name,
            source=source,
            tables=tables,
            schema=schema,
            version=version,
            parent_version=parent,
            pipeline_id=pipeline_id,
            pipeline_hash=pipeline_hash,
            project_id=project_id,
        )

    def update_schema(self, record: DatasetRecord, schema: Schema) -> DatasetRecord:
        with self.db.session(record.tenant_id) as s:
            v = self._version_row(s, record.tenant_id, record.id, record.version)
            v.schema_json = schema.model_dump(mode="json")
            v.profile_json = None  # names/types may have changed
            ds = s.get(Dataset, record.id)
            return _to_record(ds, v)

    def get_profile(self, record: DatasetRecord) -> dict[str, Any] | None:
        with self.db.session(record.tenant_id) as s:
            return self._version_row(s, record.tenant_id, record.id, record.version).profile_json

    def set_profile(self, record: DatasetRecord, profile: dict[str, Any]) -> None:
        with self.db.session(record.tenant_id) as s:
            self._version_row(s, record.tenant_id, record.id, record.version).profile_json = profile

    def delete(self, tenant_id: str, dataset_id: str) -> None:
        """Soft-delete the dataset and remove its files. Versions stay in metadata for lineage and audit."""
        self.get(tenant_id, dataset_id)
        with self.db.session(tenant_id) as s:
            s.get(Dataset, dataset_id).deleted_at = datetime.now(UTC)
        for key, _ in list(self.objects.list(tenant_id, f"datasets/{dataset_id}/")):
            self.objects.delete(tenant_id, key)
        shutil.rmtree(self._cache_path(tenant_id, f"datasets/{dataset_id}"), ignore_errors=True)

    # -- reads -----------------------------------------------------------
    @staticmethod
    def _version_row(s, tenant_id: str, dataset_id: str, version: int) -> DatasetVersion:
        v = s.execute(
            select(DatasetVersion).where(
                DatasetVersion.tenant_id == tenant_id, DatasetVersion.dataset_id == dataset_id, DatasetVersion.version == version
            )
        ).scalar_one_or_none()
        if v is None:
            raise DatasetNotFound(f"{dataset_id} v{version}")
        return v

    def get(self, tenant_id: str, dataset_id: str, version: int | None = None) -> DatasetRecord:
        if not DATASET_ID_RE.match(dataset_id):
            raise DatasetNotFound(dataset_id)
        with self.db.session(tenant_id) as s:
            ds = s.get(Dataset, dataset_id)
            if ds is None or ds.tenant_id != tenant_id or ds.deleted_at is not None:
                raise DatasetNotFound(dataset_id)
            return _to_record(ds, self._version_row(s, tenant_id, dataset_id, version or ds.current_version))

    def versions(self, tenant_id: str, dataset_id: str) -> list[DatasetRecord]:
        self.get(tenant_id, dataset_id)
        with self.db.session(tenant_id) as s:
            ds = s.get(Dataset, dataset_id)
            rows = s.execute(
                select(DatasetVersion)
                .where(DatasetVersion.tenant_id == tenant_id, DatasetVersion.dataset_id == dataset_id)
                .order_by(DatasetVersion.version)
            ).scalars()
            return [_to_record(ds, v) for v in rows]

    def list(self, tenant_id: str, projects: set[str] | None = None) -> list[DatasetRecord]:
        """Current versions of the tenant's datasets; ``projects`` restricts to those project ids."""
        _check_tenant(tenant_id)
        with self.db.session(tenant_id) as s:
            q = (
                select(Dataset, DatasetVersion)
                .join(DatasetVersion, (DatasetVersion.dataset_id == Dataset.id) & (DatasetVersion.version == Dataset.current_version))
                .where(Dataset.tenant_id == tenant_id, Dataset.deleted_at.is_(None))
                .order_by(Dataset.created_at.desc())
            )
            if projects is not None:
                q = q.where(Dataset.project_id.in_(projects))
            rows = s.execute(q).all()
            return [_to_record(ds, v) for ds, v in rows]
