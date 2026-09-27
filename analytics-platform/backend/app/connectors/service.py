"""External data sources (ING-007): the tenant's own S3/GCS buckets and PostgreSQL/MySQL databases.

* Credentials are written to the SecretStore (``connector-<id>``) and never returned or logged.
  Only non-secret settings (bucket, host, port, database) are kept in the metadata DB.
* Every host is checked by the SSRF guard (private/loopback/link-local blocked unless allowlisted).
* Imports run as ``connector.import`` jobs and create a new dataset through the regular ingest
  path (archive extraction, format conversion, transcoding, the 1 GB limit, quotas).
* Database imports run one validated, read-only SELECT (``validate_select``) inside a read-only
  transaction with a statement timeout, capped at a row limit and at 1 GB.
"""

from __future__ import annotations

import json
import re
import shutil
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Literal

import pandas as pd
from pydantic import BaseModel, Field, SecretStr, field_validator
from sqlalchemy import select

from ..analytics.sql_sandbox import UnsafeQueryError, validate_select
from ..cloud.base import ObjectStore
from ..db.models import Connector
from ..ingestion.converters import write_frame
from ..storage.datasets import DatasetRecord, DatasetTooLarge
from .ssrf import BlockedHost, check_host

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

ConnectorKind = Literal["s3", "gcs", "postgresql", "mysql", "sqlite"]
MAX_OBJECTS = 100
FETCH_ROWS = 10_000
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$")
_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:.]+\]?$")
_NAME_RE = re.compile(r"^[A-Za-z0-9 _.-]{1,200}$")
ALLOWLIST_SETTING = "connector_allowlist"


class ConnectorError(ValueError):
    """Invalid connector configuration or import request (a 4xx, never retried)."""


# -- configuration ---------------------------------------------------------------------------


class ObjectStorageConfig(BaseModel):
    bucket: str
    region: str = Field(default="us-east-1", pattern=r"^[a-z0-9-]{2,40}$")
    project: str | None = Field(default=None, max_length=100)
    # S3-compatible stores (MinIO, R2, ...). SSRF-checked like database hosts.
    endpoint_url: str | None = Field(default=None, max_length=500)

    @field_validator("bucket")
    @classmethod
    def _bucket(cls, v: str) -> str:
        if not _BUCKET_RE.match(v):
            raise ValueError("invalid bucket name")
        return v

    @field_validator("endpoint_url")
    @classmethod
    def _endpoint(cls, v: str | None) -> str | None:
        if v is not None and not re.match(r"^https?://[A-Za-z0-9.\-\[\]:]+(:\d{1,5})?/?$", v):
            raise ValueError("endpoint_url must be http(s)://host[:port]")
        return v


class DatabaseConfig(BaseModel):
    host: str | None = Field(default=None, max_length=253)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str = Field(min_length=1, max_length=500)
    sslmode: Literal["disable", "prefer", "require", "verify-ca", "verify-full"] | None = None

    @field_validator("host")
    @classmethod
    def _host(cls, v: str | None) -> str | None:
        if v is not None and not _HOST_RE.match(v):
            raise ValueError("invalid host")
        return v


class S3Credentials(BaseModel):
    access_key_id: SecretStr
    secret_access_key: SecretStr
    session_token: SecretStr | None = None


class GCSCredentials(BaseModel):
    service_account_json: SecretStr


class DatabaseCredentials(BaseModel):
    username: SecretStr | None = None
    password: SecretStr | None = None


def _config_model(kind: str) -> type[BaseModel]:
    return ObjectStorageConfig if kind in ("s3", "gcs") else DatabaseConfig


def _credentials_model(kind: str) -> type[BaseModel]:
    return {"s3": S3Credentials, "gcs": GCSCredentials}.get(kind, DatabaseCredentials)


class ConnectorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: ConnectorKind
    config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("name may contain letters, digits, spaces, '_', '-' and '.'")
        return v


class ConnectorOut(BaseModel):
    id: str
    name: str
    kind: str
    config: dict[str, Any]
    created_by: str
    created_at: Any


class ImportRequest(BaseModel):
    project_id: str | None = Field(default=None, max_length=40)
    name: str | None = Field(default=None, max_length=200)
    # object storage: one object, or every object under a prefix (each file becomes a table)
    key: str | None = Field(default=None, min_length=1, max_length=1024)
    prefix: str | None = Field(default=None, max_length=1024)
    # databases
    query: str | None = Field(default=None, min_length=1, max_length=20_000)
    row_limit: int | None = Field(default=None, ge=1)


def _out(row: Connector) -> ConnectorOut:
    return ConnectorOut(
        id=row.id, name=row.name, kind=row.kind, config=dict(row.config), created_by=row.created_by, created_at=row.created_at
    )


# -- clients -----------------------------------------------------------------------------------


def _s3_store(config: ObjectStorageConfig, creds: S3Credentials) -> ObjectStore:
    import boto3

    from ..cloud.aws import S3ObjectStore

    client = boto3.client(
        "s3",
        region_name=config.region,
        endpoint_url=config.endpoint_url,
        aws_access_key_id=creds.access_key_id.get_secret_value(),
        aws_secret_access_key=creds.secret_access_key.get_secret_value(),
        aws_session_token=creds.session_token.get_secret_value() if creds.session_token else None,
    )
    return S3ObjectStore(config.bucket, region=config.region, client=client)


def _gcs_store(config: ObjectStorageConfig, creds: GCSCredentials) -> ObjectStore:
    from google.cloud import storage
    from google.oauth2 import service_account

    try:
        info = json.loads(creds.service_account_json.get_secret_value())
    except json.JSONDecodeError as exc:
        raise ConnectorError("service_account_json is not valid JSON") from exc
    credentials = service_account.Credentials.from_service_account_info(info)
    client = storage.Client(project=config.project or info.get("project_id"), credentials=credentials)
    from ..cloud.gcp import GCSObjectStore

    return GCSObjectStore(config.bucket, client=client)


# Tests may replace these factories (e.g. to inject a fake GCS client).
OBJECT_STORE_FACTORIES: dict[str, Callable[[Any, Any], ObjectStore]] = {"s3": _s3_store, "gcs": _gcs_store}


# -- service -----------------------------------------------------------------------------------


class ConnectorService:
    def __init__(self, state: AppState):
        self.state = state
        self.notes: list[str] = []  # messages from the last import (e.g. truncation)

    # allowlists
    def tenant_allowlist(self, tenant_id: str) -> list[str]:
        return list((self.state.get_setting(tenant_id, ALLOWLIST_SETTING) or {}).get("hosts", []))

    def set_tenant_allowlist(self, tenant_id: str, hosts: list[str]) -> list[str]:
        self.state.put_setting(tenant_id, ALLOWLIST_SETTING, {"hosts": hosts})
        return hosts

    def check_host(self, tenant_id: str, host: str, port: int | None = None) -> list[str]:
        return check_host(
            host,
            port,
            tenant_allowlist=self.tenant_allowlist(tenant_id),
            platform_allowlist=self.state.settings.connector_host_allowlist,
        )

    # CRUD
    def validate(self, tenant_id: str, body: ConnectorCreate) -> tuple[BaseModel, BaseModel]:
        if body.kind == "sqlite" and not self.state.settings.connector_allow_sqlite:
            raise ConnectorError("sqlite connectors are disabled (tests and local development only)")
        try:
            config = _config_model(body.kind).model_validate(body.config)
            creds = _credentials_model(body.kind).model_validate(body.credentials)
        except ValueError as exc:
            raise ConnectorError(str(exc)) from exc
        if isinstance(config, DatabaseConfig) and body.kind != "sqlite":
            if not config.host:
                raise ConnectorError("host is required")
            try:
                self.check_host(tenant_id, config.host, config.port)
            except BlockedHost as exc:
                raise ConnectorError(str(exc)) from exc
        if isinstance(config, ObjectStorageConfig) and config.endpoint_url:
            host = re.sub(r"^https?://", "", config.endpoint_url).split("/")[0].rsplit(":", 1)[0].strip("[]")
            try:
                self.check_host(tenant_id, host)
            except BlockedHost as exc:
                raise ConnectorError(str(exc)) from exc
        return config, creds

    def create(self, tenant_id: str, actor: str, body: ConnectorCreate) -> ConnectorOut:
        config, creds = self.validate(tenant_id, body)
        connector_id = f"conn_{uuid.uuid4().hex}"
        secret_name = f"connector-{connector_id}"
        secrets = {k: (v.get_secret_value() if isinstance(v, SecretStr) else v) for k, v in creds}
        self.state.secrets.put(tenant_id, secret_name, json.dumps(secrets))
        try:
            with self.state.db.session(tenant_id) as s:
                if s.execute(select(Connector).where(Connector.tenant_id == tenant_id, Connector.name == body.name)).scalar_one_or_none():
                    raise ConnectorError(f"a connector named {body.name!r} already exists")
                row = Connector(
                    id=connector_id,
                    tenant_id=tenant_id,
                    name=body.name,
                    kind=body.kind,
                    config=config.model_dump(mode="json", exclude_none=True),
                    secret_name=secret_name,
                    created_by=actor,
                )
                s.add(row)
                s.flush()
                return _out(row)
        except Exception:
            self.state.secrets.delete(tenant_id, secret_name)
            raise

    def list(self, tenant_id: str) -> list[ConnectorOut]:
        with self.state.db.session(tenant_id) as s:
            rows = s.execute(select(Connector).where(Connector.tenant_id == tenant_id).order_by(Connector.created_at)).scalars()
            return [_out(r) for r in rows]

    def _row(self, s, tenant_id: str, connector_id: str) -> Connector:
        row = s.get(Connector, connector_id)
        if row is None or row.tenant_id != tenant_id:
            raise LookupError(connector_id)
        return row

    def get(self, tenant_id: str, connector_id: str) -> ConnectorOut:
        with self.state.db.session(tenant_id) as s:
            return _out(self._row(s, tenant_id, connector_id))

    def delete(self, tenant_id: str, connector_id: str) -> None:
        with self.state.db.session(tenant_id) as s:
            row = self._row(s, tenant_id, connector_id)
            secret_name = row.secret_name
            s.delete(row)
        self.state.secrets.delete(tenant_id, secret_name)

    def _load(self, tenant_id: str, connector_id: str) -> tuple[str, BaseModel, BaseModel]:
        with self.state.db.session(tenant_id) as s:
            row = self._row(s, tenant_id, connector_id)
            kind, config, secret_name = row.kind, dict(row.config), row.secret_name
        raw = self.state.secrets.get(tenant_id, secret_name)
        if raw is None:
            raise ConnectorError("connector credentials are missing; re-create the connector")
        return kind, _config_model(kind).model_validate(config), _credentials_model(kind).model_validate(json.loads(raw))

    def check_import(self, kind: str, body: ImportRequest) -> None:
        if kind in ("s3", "gcs"):
            if bool(body.key) == (body.prefix is not None):
                raise ConnectorError("pass exactly one of key or prefix")
            if body.query:
                raise ConnectorError("query is only for database connectors")
        else:
            if not body.query:
                raise ConnectorError("query is required for database connectors")
            try:
                validate_select(body.query.strip().rstrip(";"))
            except UnsafeQueryError as exc:
                raise ConnectorError(f"only a single read-only SELECT is allowed: {exc}") from exc
            if body.key or body.prefix:
                raise ConnectorError("key/prefix are only for object-storage connectors")

    # -- imports (run inside the job) -------------------------------------------------------
    def run_import(self, tenant_id: str, actor: str, connector_id: str, params: dict[str, Any], progress=None) -> DatasetRecord:
        body = ImportRequest.model_validate(params)
        kind, config, creds = self._load(tenant_id, connector_id)
        self.check_import(kind, body)
        scratch = self.state.store._scratch(tenant_id) / f"connector-{uuid.uuid4().hex}"
        scratch.mkdir(parents=True)
        self.notes = []
        try:
            if kind in ("s3", "gcs"):
                filename, path = self._fetch_objects(tenant_id, kind, config, creds, body, scratch, progress)  # type: ignore[arg-type]
            else:
                filename, path = self._fetch_query(tenant_id, kind, config, creds, body, scratch, progress)  # type: ignore[arg-type]
            if progress:
                progress(0.8, "storing dataset")
            return self.state.store.ingest_file(
                tenant_id,
                actor,
                filename,
                path,
                name=body.name or Path(filename).stem,
                project_id=params.get("project_id"),
                source="connector",
            )
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def _fetch_objects(
        self, tenant_id: str, kind: str, config: ObjectStorageConfig, creds: BaseModel, body: ImportRequest, scratch: Path, progress
    ) -> tuple[str, Path]:
        if config.endpoint_url:  # re-check at connect time: DNS may have changed since creation
            host = re.sub(r"^https?://", "", config.endpoint_url).split("/")[0].rsplit(":", 1)[0].strip("[]")
            try:
                self.check_host(tenant_id, host)
            except BlockedHost as exc:
                raise ConnectorError(str(exc)) from exc
        store = OBJECT_STORE_FACTORIES[kind](config, creds)
        limit = self.state.store.max_dataset_bytes
        if body.key:
            objects = [(body.key, next((size for k, size in store.list(body.key) if k == body.key), None))]
            if objects[0][1] is None:
                raise ConnectorError(f"object {body.key!r} not found in bucket {config.bucket!r}")
        else:
            objects = [(k, size) for k, size in store.list(body.prefix or "") if not k.endswith("/")]
            if not objects:
                raise ConnectorError(f"no objects under prefix {body.prefix!r}")
            if len(objects) > MAX_OBJECTS:
                raise ConnectorError(f"more than {MAX_OBJECTS} objects under the prefix; narrow it down")
        if sum(size or 0 for _, size in objects) > limit:
            raise DatasetTooLarge(limit)
        local: list[tuple[str, Path]] = []
        for i, (key, _) in enumerate(objects):
            target = scratch / f"object-{i:03d}"
            store.download(key, target)
            if target.stat().st_size > limit:
                raise DatasetTooLarge(limit)
            local.append((PurePosixPath(key).name or f"object-{i}", target))
            if progress:
                progress(0.1 + 0.6 * (i + 1) / len(objects), f"downloaded {i + 1}/{len(objects)} objects")
        if len(local) == 1:
            return local[0]
        # Several objects: bundle them (uncompressed) so each becomes one table of the dataset.
        bundle = scratch / "objects.zip"
        with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_STORED) as zf:
            names: set[str] = set()
            for name, path in local:
                unique, n = name, 2
                while unique in names:
                    unique = f"{n}_{name}"
                    n += 1
                names.add(unique)
                zf.write(path, unique)
                path.unlink()
        return f"{Path(body.prefix or 'objects').name or 'objects'}.zip", bundle

    def _engine(self, tenant_id: str, kind: str, config: DatabaseConfig, creds: DatabaseCredentials):
        from sqlalchemy import create_engine
        from sqlalchemy.engine import URL
        from sqlalchemy.pool import NullPool

        user = creds.username.get_secret_value() if creds.username else None
        password = creds.password.get_secret_value() if creds.password else None
        if kind == "sqlite":
            if not self.state.settings.connector_allow_sqlite:
                raise ConnectorError("sqlite connectors are disabled")
            return create_engine(URL.create("sqlite", database=config.database), poolclass=NullPool)
        assert config.host is not None
        try:
            addresses = self.check_host(tenant_id, config.host, config.port)
        except BlockedHost as exc:
            raise ConnectorError(str(exc)) from exc
        pinned = addresses[0]  # connect to the checked address, not the name again (DNS rebinding)
        if kind == "postgresql":
            query = {"hostaddr": pinned, "connect_timeout": "10"}
            if config.sslmode:
                query["sslmode"] = config.sslmode
            url = URL.create(
                "postgresql+psycopg",
                username=user,
                password=password,
                host=config.host,
                port=config.port or 5432,
                database=config.database,
                query=query,
            )
        else:
            try:
                import pymysql  # noqa: F401
            except ImportError as exc:
                raise ConnectorError(
                    "MySQL imports need the PyMySQL driver (pip install 'analytics-platform-backend[connectors]')"
                ) from exc
            url = URL.create(
                "mysql+pymysql", username=user, password=password, host=pinned, port=config.port or 3306, database=config.database
            )
        return create_engine(url, poolclass=NullPool)

    def _fetch_query(
        self, tenant_id: str, kind: str, config: DatabaseConfig, creds: DatabaseCredentials, body: ImportRequest, scratch: Path, progress
    ) -> tuple[str, Path]:
        from sqlalchemy.exc import SQLAlchemyError

        settings = self.state.settings
        row_limit = min(body.row_limit or settings.connector_max_rows, settings.connector_max_rows)
        byte_limit = self.state.store.max_dataset_bytes
        sql = body.query.strip().rstrip(";").strip()  # type: ignore[union-attr]
        validate_select(sql)
        timeout = settings.connector_query_timeout_seconds
        # The user's SELECT is wrapped verbatim (it was validated as exactly one SELECT); newlines keep a
        # trailing comment from swallowing the wrapper. The limit is an integer we control.
        wrapped = f"SELECT * FROM (\n{sql}\n) AS q LIMIT {int(row_limit) + 1}"
        engine = self._engine(tenant_id, kind, config, creds)
        frames: list[pd.DataFrame] = []
        rows = approx_bytes = 0
        truncated = False
        try:
            with engine.connect() as conn:
                if kind == "postgresql":
                    conn.exec_driver_sql("SET TRANSACTION READ ONLY")
                    conn.exec_driver_sql(f"SET LOCAL statement_timeout = {int(timeout) * 1000}")
                elif kind == "mysql":
                    conn.exec_driver_sql("SET SESSION TRANSACTION READ ONLY")
                    conn.exec_driver_sql(f"SET SESSION MAX_EXECUTION_TIME = {int(timeout) * 1000}")
                else:
                    conn.exec_driver_sql("PRAGMA query_only = ON")
                result = conn.execution_options(stream_results=True).exec_driver_sql(wrapped)
                columns = list(result.keys())
                while batch := result.fetchmany(FETCH_ROWS):
                    frame = pd.DataFrame.from_records([tuple(r) for r in batch], columns=columns)
                    if rows + len(frame) > row_limit:
                        frame = frame.iloc[: row_limit - rows]
                        truncated = True
                    rows += len(frame)
                    approx_bytes += int(frame.memory_usage(deep=True).sum())
                    if approx_bytes > byte_limit:
                        raise DatasetTooLarge(byte_limit)
                    frames.append(frame)
                    if progress:
                        progress(0.1 + min(0.6, 0.6 * rows / row_limit), f"fetched {rows:,} rows")
                    if truncated:
                        break
                conn.rollback()
        except SQLAlchemyError as exc:
            raise ConnectorError(f"query failed: {str(exc.orig if getattr(exc, 'orig', None) else exc).splitlines()[0][:500]}") from exc
        finally:
            engine.dispose()
        frame = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=columns)
        if frame.empty:
            raise ConnectorError("the query returned no rows")
        out = scratch / "query.parquet"
        write_frame(frame, out)
        if truncated:
            self.notes.append(f"result truncated at the row limit of {row_limit:,} rows")
        name = body.name or f"{Path(config.database).stem}_query"
        return f"{re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:100]}.parquet", out
