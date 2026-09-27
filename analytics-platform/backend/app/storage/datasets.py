"""Tenant-scoped dataset storage (ING-005, ING-009, ING-010, MT-001, MT-006, MT-007).

Layout: ``{data_dir}/tenants/{tenant_id}/datasets/{dataset_id}/``, holding
``metadata.json`` plus one file per table. Raw files are written once and never
modified (ANA-NFR-002). This local-disk implementation defines the interface;
production uses object storage under the same per-tenant prefix, encrypted with
a per-tenant key.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field

from ..config import settings
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


class TableRecord(BaseModel):
    name: str
    file: str  # relative to the dataset directory
    format: DataFormat
    encoding: str = "utf-8"
    size_bytes: int
    sha256: str
    original_filename: str | None = None


class DatasetRecord(BaseModel):
    id: str
    tenant_id: str
    name: str
    version: int = 1
    source: str  # "upload" | "generated"
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


class DatasetStore:
    def __init__(self, root: Path | None = None, *, max_dataset_bytes: int | None = None, tenant_quota_bytes: int | None = None):
        self.root = (root or settings.data_dir).resolve()
        self.max_dataset_bytes = max_dataset_bytes or settings.max_dataset_bytes
        self.tenant_quota_bytes = tenant_quota_bytes or settings.tenant_storage_quota_bytes
        self._lock = threading.Lock()

    # -- paths -----------------------------------------------------------
    def _tenant_dir(self, tenant_id: str) -> Path:
        if not TENANT_ID_RE.match(tenant_id):
            raise ValueError("invalid tenant id")
        return self.root / "tenants" / tenant_id / "datasets"

    def dataset_dir(self, tenant_id: str, dataset_id: str) -> Path:
        if not DATASET_ID_RE.match(dataset_id):
            raise DatasetNotFound(dataset_id)
        path = self._tenant_dir(tenant_id) / dataset_id
        if not (path / "metadata.json").exists():
            raise DatasetNotFound(dataset_id)
        return path

    def table_path(self, record: DatasetRecord, table: TableRecord) -> Path:
        path = (self.dataset_dir(record.tenant_id, record.id) / table.file).resolve()
        if self._tenant_dir(record.tenant_id).resolve() not in path.parents:
            raise PermissionError("table path escapes the tenant directory")
        return path

    # -- quota -----------------------------------------------------------
    def tenant_usage_bytes(self, tenant_id: str) -> int:
        return sum(r.size_bytes for r in self.list(tenant_id))

    def _check_quota(self, tenant_id: str, incoming: int) -> None:
        if self.tenant_usage_bytes(tenant_id) + incoming > self.tenant_quota_bytes:
            raise QuotaExceeded(f"tenant storage quota of {self.tenant_quota_bytes / 1024**3:.0f} GB would be exceeded")

    # -- writes ----------------------------------------------------------
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
    ) -> DatasetRecord:
        """Stream an upload to disk, enforcing the size limit before and during transfer (ING-NFR-004)."""
        if declared_size is not None and declared_size > self.max_dataset_bytes:
            raise DatasetTooLarge(self.max_dataset_bytes)
        self._check_quota(tenant_id, declared_size or 0)
        tenant_dir = self._tenant_dir(tenant_id)
        tenant_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        head = b""
        fd, tmp_name = tempfile.mkstemp(dir=tenant_dir, prefix=".upload-")
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
            record = DatasetRecord(
                id=f"ds_{uuid.uuid4().hex}",
                tenant_id=tenant_id,
                name=name or Path(safe).stem,
                source="upload",
                created_at=datetime.now(UTC).isoformat(),
                created_by=actor,
                size_bytes=size,
                tables=[
                    TableRecord(
                        name=_table_name(safe),
                        file=f"raw/{safe}",
                        format=fmt,
                        encoding=encoding,
                        size_bytes=size,
                        sha256=sha,
                        original_filename=filename,
                    )
                ],
            )
            ds_dir = tenant_dir / record.id
            (ds_dir / "raw").mkdir(parents=True)
            shutil.move(str(tmp), ds_dir / "raw" / safe)
            os.chmod(ds_dir / "raw" / safe, 0o444)  # immutable raw file (ING-010)
            self._write_metadata(record)
            return record
        finally:
            tmp.unlink(missing_ok=True)

    def save_frames(self, tenant_id: str, actor: str, name: str, frames: dict[str, pd.DataFrame], schema: Schema | None) -> DatasetRecord:
        """Persist generated data as Parquet, one file per entity."""
        tenant_dir = self._tenant_dir(tenant_id)
        record = DatasetRecord(
            id=f"ds_{uuid.uuid4().hex}",
            tenant_id=tenant_id,
            name=name,
            source="generated",
            created_at=datetime.now(UTC).isoformat(),
            created_by=actor,
            schema_=schema,
        )
        ds_dir = tenant_dir / record.id
        (ds_dir / "tables").mkdir(parents=True)
        try:
            for table, frame in frames.items():
                path = ds_dir / "tables" / f"{table}.parquet"
                pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), path)
                data = path.read_bytes()
                record.tables.append(
                    TableRecord(
                        name=table,
                        file=f"tables/{table}.parquet",
                        format=DataFormat.PARQUET,
                        encoding="binary",
                        size_bytes=len(data),
                        sha256=hashlib.sha256(data).hexdigest(),
                    )
                )
            record.size_bytes = sum(t.size_bytes for t in record.tables)
            if record.size_bytes > self.max_dataset_bytes:
                raise DatasetTooLarge(self.max_dataset_bytes)
            self._check_quota(tenant_id, record.size_bytes)
            self._write_metadata(record)
        except Exception:
            shutil.rmtree(ds_dir, ignore_errors=True)
            raise
        return record

    def update_schema(self, record: DatasetRecord, schema: Schema) -> DatasetRecord:
        record = record.model_copy(update={"schema_": schema})
        self._write_metadata(record)
        return record

    def _write_metadata(self, record: DatasetRecord) -> None:
        ds_dir = self._tenant_dir(record.tenant_id) / record.id
        tmp = ds_dir / "metadata.json.tmp"
        tmp.write_text(record.model_dump_json(indent=2))
        tmp.replace(ds_dir / "metadata.json")

    # -- reads -----------------------------------------------------------
    def get(self, tenant_id: str, dataset_id: str) -> DatasetRecord:
        path = self.dataset_dir(tenant_id, dataset_id) / "metadata.json"
        record = DatasetRecord.model_validate(json.loads(path.read_text()))
        if record.tenant_id != tenant_id:  # defense in depth for MT-001
            raise DatasetNotFound(dataset_id)
        return record

    def list(self, tenant_id: str) -> list[DatasetRecord]:
        tenant_dir = self._tenant_dir(tenant_id)
        if not tenant_dir.exists():
            return []
        records = []
        for meta in sorted(tenant_dir.glob("ds_*/metadata.json")):
            records.append(DatasetRecord.model_validate(json.loads(meta.read_text())))
        return sorted(records, key=lambda r: r.created_at, reverse=True)
