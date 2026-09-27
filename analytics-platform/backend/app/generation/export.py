"""Export generated or stored datasets (GEN-008)."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date, datetime
from enum import Enum
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


class ExportFormat(str, Enum):
    CSV = "csv"
    JSON = "json"
    JSONL = "jsonl"
    PARQUET = "parquet"
    SQL = "sql"


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalars
        return value.item()
    raise TypeError(f"not JSON serializable: {type(value).__name__}")


def to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    frame = frame.astype(object).where(frame.notna(), None) if len(frame) else frame
    return frame.to_dict(orient="records")


def _sql_literal(value: Any) -> str:
    if value is None or (isinstance(value, float) and value != value):
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (datetime, date)):
        return f"'{value.isoformat()}'"
    if isinstance(value, (list, dict)):
        value = json.dumps(value, default=_json_default)
    return "'" + str(value).replace("'", "''") + "'"


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def export_frame(name: str, frame: pd.DataFrame, fmt: ExportFormat) -> bytes:
    if fmt == ExportFormat.CSV:
        csv_frame = frame.copy()
        for col in csv_frame.columns:
            if csv_frame[col].map(lambda v: isinstance(v, list)).any():
                csv_frame[col] = csv_frame[col].map(lambda v: json.dumps(v, default=_json_default) if isinstance(v, list) else v)
        return csv_frame.to_csv(index=False).encode()
    if fmt == ExportFormat.JSON:
        return json.dumps(to_records(frame), default=_json_default, ensure_ascii=False).encode()
    if fmt == ExportFormat.JSONL:
        return "".join(json.dumps(r, default=_json_default, ensure_ascii=False) + "\n" for r in to_records(frame)).encode()
    if fmt == ExportFormat.PARQUET:
        buf = io.BytesIO()
        pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), buf)
        return buf.getvalue()
    if fmt == ExportFormat.SQL:
        cols = ", ".join(_quote_ident(c) for c in frame.columns)
        lines = [
            f"INSERT INTO {_quote_ident(name)} ({cols}) VALUES ({', '.join(_sql_literal(v) for v in row)});"
            for row in frame.astype(object).where(frame.notna(), None).itertuples(index=False, name=None)
        ]
        return ("\n".join(lines) + "\n").encode()
    raise ValueError(f"unsupported format {fmt}")


def export_zip(frames: dict[str, pd.DataFrame], fmt: ExportFormat) -> bytes:
    """One file per entity, zipped, for entities with relationships between them."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, frame in frames.items():
            zf.writestr(f"{name}.{fmt.value}", export_frame(name, frame, fmt))
    return buf.getvalue()
