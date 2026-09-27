"""Read-only, sandboxed SQL over one dataset (USR-003, LLM-007, LLM-NFR-007, SEC-009).

Defense in depth:
1. Statically, the SQL must parse as exactly one SELECT statement. DuckDB's
   ``json_serialize_sql`` only serializes SELECTs, so DDL, DML, COPY, ATTACH,
   PRAGMA and SET are all rejected.
2. At runtime, the dataset's tables are loaded into a fresh in-memory database,
   then external access, extension loading and configuration changes are locked
   before any user SQL runs. Table functions such as ``read_csv('/etc/passwd')``
   fail with a PermissionException.
3. Resource limits: memory limit, thread cap, wall-clock timeout (interrupt) and a row cap.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
from pydantic import BaseModel

from ..config import settings
from ..ingestion.formats import DataFormat, relation_sql


class UnsafeQueryError(ValueError):
    pass


class QueryTimeout(TimeoutError):
    pass


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool


def validate_select(sql: str) -> None:
    """Raise UnsafeQueryError unless ``sql`` is a single SELECT (CTEs allowed)."""
    if not sql or not sql.strip():
        raise UnsafeQueryError("query is empty")
    if len(sql) > 20_000:
        raise UnsafeQueryError("query is too long")
    con = duckdb.connect(":memory:")
    try:
        parsed = json.loads(con.execute("SELECT json_serialize_sql(?)", [sql]).fetchone()[0])
    finally:
        con.close()
    if parsed.get("error"):
        message = parsed.get("error_message", "invalid query")
        if "Only SELECT" in message:
            message = "only a single read-only SELECT statement is allowed"
        raise UnsafeQueryError(message)
    if len(parsed.get("statements", [])) != 1:
        raise UnsafeQueryError("exactly one SELECT statement is allowed")


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def open_sandbox(
    tables: dict[str, tuple[Path, DataFormat, str]],
    *,
    renames: dict[str, dict[str, str]] | None = None,
    memory_limit: str = "1GB",
) -> duckdb.DuckDBPyConnection:
    """Load ``{table_name: (path, format, encoding)}`` into a locked-down connection.

    ``renames`` maps table → {source column: canonical name}, so queries use the
    confirmed schema's field names. A single-table dataset is also exposed as
    ``data``, which the LLM prompts refer to.
    """
    renames = renames or {}
    con = duckdb.connect(":memory:", config={"threads": 2, "memory_limit": memory_limit})
    try:
        for name, (path, fmt, encoding) in tables.items():
            if fmt == DataFormat.XLSX:
                frame = pd.read_excel(path, engine="openpyxl")
                con.register("__xlsx_tmp", frame)
                con.execute(f"CREATE TABLE {_quote_ident(name)} AS SELECT * FROM __xlsx_tmp")
                con.unregister("__xlsx_tmp")
            else:
                con.execute(f"CREATE TABLE {_quote_ident(name)} AS SELECT * FROM {relation_sql(path, fmt, encoding)}")
            for source, target in renames.get(name, {}).items():
                con.execute(f"ALTER TABLE {_quote_ident(name)} RENAME COLUMN {_quote_ident(source)} TO {_quote_ident(target)}")
        if len(tables) == 1 and "data" not in tables:
            only = next(iter(tables))
            con.execute(f"CREATE VIEW data AS SELECT * FROM {_quote_ident(only)}")
        con.execute("SET enable_external_access = false")
        con.execute("SET autoinstall_known_extensions = false")
        con.execute("SET autoload_known_extensions = false")
        con.execute("SET lock_configuration = true")
    except Exception:
        con.close()
        raise
    return con


def run_query(
    con: duckdb.DuckDBPyConnection,
    sql: str,
    *,
    row_limit: int | None = None,
    timeout_seconds: float | None = None,
    params: dict[str, Any] | None = None,
) -> QueryResult:
    sql = sql.strip().rstrip(";").strip()
    validate_select(sql)
    row_limit = row_limit or settings.query_row_limit
    timeout_seconds = timeout_seconds or settings.query_timeout_seconds
    timed_out = threading.Event()

    def _interrupt() -> None:
        timed_out.set()
        con.interrupt()

    timer = threading.Timer(timeout_seconds, _interrupt)
    timer.start()
    try:
        # Newlines keep a trailing ``--`` comment in the user SQL from swallowing the wrapper.
        wrapped = f"SELECT * FROM (\n{sql}\n) AS q LIMIT {row_limit + 1}"
        cursor = con.execute(wrapped, params) if params else con.execute(wrapped)
        columns = [d[0] for d in cursor.description]
        rows = cursor.fetchall()
    except duckdb.InterruptException as exc:
        raise QueryTimeout(f"query exceeded {timeout_seconds:.0f}s") from exc
    except duckdb.Error as exc:
        if timed_out.is_set():
            raise QueryTimeout(f"query exceeded {timeout_seconds:.0f}s") from exc
        raise UnsafeQueryError(str(exc).split("\n")[0]) from exc
    finally:
        timer.cancel()
    truncated = len(rows) > row_limit
    rows = rows[:row_limit]
    return QueryResult(
        columns=columns,
        rows=[[_jsonable(v) for v in row] for row in rows],
        row_count=len(rows),
        truncated=truncated,
    )


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)
