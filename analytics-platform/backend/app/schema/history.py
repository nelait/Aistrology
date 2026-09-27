"""Versioned schema history per project (SCH-010).

Saving a schema under a name creates version 1; saving it again creates a new
version only when the content changed (compared by a SHA-256 of the canonical
JSON). Versions are immutable, and any two can be diffed with :func:`diff_schemas`.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import SavedSchema, SavedSchemaVersion
from ..db.session import Database
from .diff import SchemaDiff, diff_schemas
from .model import Schema, ensure_valid


class SchemaNotFound(LookupError):
    pass


class SchemaVersionOut(BaseModel):
    version: int
    content_hash: str
    source_format: str | None = None
    message: str | None = None
    created_by: str
    created_at: datetime
    schema_: Schema | None = Field(default=None, alias="schema")

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class SavedSchemaOut(BaseModel):
    id: str
    project_id: str
    name: str
    current_version: int
    created_by: str
    created_at: datetime
    updated_at: datetime
    versions: list[SchemaVersionOut] | None = None


def content_hash(schema: Schema) -> str:
    payload = json.dumps(schema.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _utc(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def _out(row: SavedSchema, versions: list[SavedSchemaVersion] | None = None) -> SavedSchemaOut:
    return SavedSchemaOut(
        id=row.id,
        project_id=row.project_id,
        name=row.name,
        current_version=row.current_version,
        created_by=row.created_by,
        created_at=_utc(row.created_at),
        updated_at=_utc(row.updated_at),
        versions=None if versions is None else [_version_out(v) for v in versions],
    )


def _version_out(v: SavedSchemaVersion, with_schema: bool = False) -> SchemaVersionOut:
    return SchemaVersionOut(
        version=v.version,
        content_hash=v.content_hash,
        source_format=v.source_format,
        message=v.message,
        created_by=v.created_by,
        created_at=_utc(v.created_at),
        schema_=Schema.model_validate(v.schema_json) if with_schema else None,
    )


class SchemaHistory:
    def __init__(self, db: Database):
        self.db = db

    def save(
        self,
        tenant_id: str,
        actor: str,
        project_id: str,
        name: str,
        schema: Schema,
        *,
        message: str | None = None,
        source_format: str | None = None,
    ) -> tuple[SavedSchemaOut, bool]:
        """Returns (record, created) — ``created`` is False when the content equals the latest version."""
        ensure_valid(schema)
        digest = content_hash(schema)
        with self.db.session(tenant_id) as s:
            row = s.execute(
                select(SavedSchema).where(
                    SavedSchema.tenant_id == tenant_id, SavedSchema.project_id == project_id, SavedSchema.name == name
                )
            ).scalar_one_or_none()
            if row is None:
                row = SavedSchema(tenant_id=tenant_id, project_id=project_id, name=name, current_version=0, created_by=actor)
                s.add(row)
                s.flush()
            else:
                latest = self._version_row(s, tenant_id, row.id, row.current_version)
                if latest.content_hash == digest:
                    return _out(row), False
            row.current_version += 1
            row.updated_at = datetime.now(UTC)
            s.add(
                SavedSchemaVersion(
                    tenant_id=tenant_id,
                    schema_id=row.id,
                    version=row.current_version,
                    schema_json=schema.model_dump(mode="json"),
                    content_hash=digest,
                    source_format=source_format,
                    message=message,
                    created_by=actor,
                )
            )
            s.flush()
            return _out(row), True

    def list(self, tenant_id: str, projects: set[str] | None = None) -> list[SavedSchemaOut]:
        with self.db.session(tenant_id) as s:
            q = select(SavedSchema).where(SavedSchema.tenant_id == tenant_id).order_by(SavedSchema.updated_at.desc())
            if projects is not None:
                q = q.where(SavedSchema.project_id.in_(projects))
            return [_out(r) for r in s.execute(q).scalars()]

    def get(self, tenant_id: str, schema_id: str) -> SavedSchemaOut:
        with self.db.session(tenant_id) as s:
            row = self._row(s, tenant_id, schema_id)
            versions = (
                s.execute(
                    select(SavedSchemaVersion)
                    .where(SavedSchemaVersion.tenant_id == tenant_id, SavedSchemaVersion.schema_id == schema_id)
                    .order_by(SavedSchemaVersion.version)
                )
                .scalars()
                .all()
            )
            return _out(row, list(versions))

    def version(self, tenant_id: str, schema_id: str, version: int | None = None) -> SchemaVersionOut:
        with self.db.session(tenant_id) as s:
            row = self._row(s, tenant_id, schema_id)
            return _version_out(self._version_row(s, tenant_id, schema_id, version or row.current_version), with_schema=True)

    def diff(self, tenant_id: str, schema_id: str, from_version: int | None = None, to_version: int | None = None) -> SchemaDiff:
        """Default: the previous version against the latest."""
        current = self.get(tenant_id, schema_id).current_version
        to_version = to_version or current
        from_version = from_version or max(1, to_version - 1)
        a = self.version(tenant_id, schema_id, from_version).schema_
        b = self.version(tenant_id, schema_id, to_version).schema_
        return diff_schemas(a, b)  # type: ignore[arg-type]

    @staticmethod
    def _row(s, tenant_id: str, schema_id: str) -> SavedSchema:
        row = s.get(SavedSchema, schema_id)
        if row is None or row.tenant_id != tenant_id:
            raise SchemaNotFound(schema_id)
        return row

    @staticmethod
    def _version_row(s, tenant_id: str, schema_id: str, version: int) -> SavedSchemaVersion:
        v = s.execute(
            select(SavedSchemaVersion).where(
                SavedSchemaVersion.tenant_id == tenant_id, SavedSchemaVersion.schema_id == schema_id, SavedSchemaVersion.version == version
            )
        ).scalar_one_or_none()
        if v is None:
            raise SchemaNotFound(f"{schema_id} v{version}")
        return v
