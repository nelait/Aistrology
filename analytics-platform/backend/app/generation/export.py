"""Export generated or stored datasets (GEN-008, GEN-008a)."""

from __future__ import annotations

import io
import json
import math
import re
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
    XML = "xml"


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


# Characters XML 1.0 can't carry at all, even escaped.
_XML_ILLEGAL = re.compile("[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


def _xml_name(name: str) -> str:
    """A valid XML element name for a column/entity name."""
    out = re.sub(r"[^A-Za-z0-9_.-]", "_", str(name)) or "_"
    if not re.match(r"[A-Za-z_]", out) or out.lower().startswith("xml"):
        out = f"_{out}"
    return out


def _xml_escape(text: str) -> str:
    text = _XML_ILLEGAL.sub("", text)
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _xml_text(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and not math.isfinite(value)):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item") and not isinstance(value, (list, tuple)):
        return _xml_text(value.item())
    if isinstance(value, dict):
        return json.dumps(value, default=_json_default, ensure_ascii=False)
    return str(value)


def export_xml(name: str, frame: pd.DataFrame) -> bytes:
    """GEN-008a: ``<entity><row><field>value</field>…</row>…</entity>``.

    Nulls are omitted, arrays become repeated ``<item>`` children, and names are sanitized
    into valid XML element names. The layout round-trips through XML ingestion (ING-003a).
    """
    root = _xml_name(name)
    tags = [_xml_name(c) for c in frame.columns]
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n', f"<{root}>\n"]
    for row in frame.astype(object).where(frame.notna(), None).itertuples(index=False, name=None) if len(frame) else []:
        parts.append("  <row>")
        for tag, value in zip(tags, row):
            if isinstance(value, (list, tuple)) or (hasattr(value, "tolist") and not hasattr(value, "item")):
                items = "".join(f"<item>{_xml_escape(t)}</item>" for t in (_xml_text(v) for v in list(value)) if t is not None)
                parts.append(f"<{tag}>{items}</{tag}>")
                continue
            text = _xml_text(value)
            if text is not None:
                parts.append(f"<{tag}>{_xml_escape(text)}</{tag}>")
        parts.append("</row>\n")
    parts.append(f"</{root}>\n")
    return "".join(parts).encode("utf-8")


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
    if fmt == ExportFormat.XML:
        return export_xml(name, frame)
    raise ValueError(f"unsupported format {fmt}")


def export_zip(frames: dict[str, pd.DataFrame], fmt: ExportFormat) -> bytes:
    """One file per entity, zipped, for entities with relationships between them."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, frame in frames.items():
            zf.writestr(f"{name}.{fmt.value}", export_frame(name, frame, fmt))
    return buf.getvalue()
