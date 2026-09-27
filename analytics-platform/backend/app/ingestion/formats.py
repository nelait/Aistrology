"""File format and encoding detection, and loading through DuckDB (ING-003, ING-003a, ING-009, ING-NFR-002).

The P1 formats (.xls, Avro, ORC, XML) are detected here and converted to Parquet at ingest
(``app.ingestion.converters``), so the loaders below only ever see the P0 formats.
"""

from __future__ import annotations

import codecs
import zipfile
from enum import Enum
from pathlib import Path

import duckdb
import pandas as pd

from ..config import settings


class DataFormat(str, Enum):
    CSV = "csv"
    TSV = "tsv"
    JSON = "json"
    JSONL = "jsonl"
    PARQUET = "parquet"
    XLSX = "xlsx"
    # ING-003a: converted to Parquet on ingest; the raw file keeps its original format.
    XLS = "xls"
    AVRO = "avro"
    ORC = "orc"
    XML = "xml"


class UnsupportedFormatError(ValueError):
    pass


_EXTENSIONS = {
    ".csv": DataFormat.CSV,
    ".tsv": DataFormat.TSV,
    ".tab": DataFormat.TSV,
    ".json": DataFormat.JSON,
    ".jsonl": DataFormat.JSONL,
    ".ndjson": DataFormat.JSONL,
    ".parquet": DataFormat.PARQUET,
    ".pq": DataFormat.PARQUET,
    ".xlsx": DataFormat.XLSX,
    ".xls": DataFormat.XLS,
    ".avro": DataFormat.AVRO,
    ".orc": DataFormat.ORC,
    ".xml": DataFormat.XML,
}
# Converted to Parquet at ingest (ING-003a).
CONVERTED_FORMATS = frozenset({DataFormat.XLS, DataFormat.AVRO, DataFormat.ORC, DataFormat.XML})
TEXT_FORMATS = frozenset({DataFormat.CSV, DataFormat.TSV, DataFormat.JSON, DataFormat.JSONL, DataFormat.XML})


def detect_encoding(head: bytes) -> str:
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if head.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    try:
        head.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError as exc:
        # A multi-byte character cut off at the end of the sample is still UTF-8.
        if exc.start >= len(head) - 3:
            return "utf-8"
        return "latin-1"


def detect_format(filename: str, head: bytes) -> DataFormat:
    """Magic bytes win over the file extension; the extension breaks ties between text formats."""
    suffix = Path(filename).suffix.lower()
    if head.startswith(b"PAR1"):
        return DataFormat.PARQUET
    if head.startswith(b"PK\x03\x04"):
        if suffix in (".xlsx", ".xlsm"):
            return DataFormat.XLSX
        raise UnsupportedFormatError("zip archives are extracted on upload; nested archives are not supported")
    if head.startswith(b"\x1f\x8b") or head[257:262] == b"ustar":
        raise UnsupportedFormatError("compressed archives are extracted on upload; nested archives are not supported")
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return DataFormat.XLS  # OLE2 compound document: legacy Excel
    if head.startswith(b"Obj\x01"):
        return DataFormat.AVRO
    if head.startswith(b"ORC"):
        return DataFormat.ORC
    if suffix in (".gz", ".zip", ".tar", ".tgz", ".bz2", ".7z", ".rar"):
        raise UnsupportedFormatError(f"{suffix} files must be valid archives")
    text = head.decode(detect_encoding(head), errors="replace").lstrip("﻿ \t\r\n")
    if text.startswith("<") or suffix == ".xml":
        return DataFormat.XML
    if suffix in (".jsonl", ".ndjson"):
        return DataFormat.JSONL
    if text.startswith("["):
        return DataFormat.JSON
    if text.startswith("{"):
        lines = [ln for ln in text.splitlines() if ln.strip()]
        # One complete object per line → JSON Lines; a single pretty-printed object → JSON.
        if len(lines) > 1 and lines[0].rstrip().endswith("}"):
            return DataFormat.JSONL
        return DataFormat.JSON
    if suffix in _EXTENSIONS and _EXTENSIONS[suffix] in (DataFormat.CSV, DataFormat.TSV):
        return _EXTENSIONS[suffix]
    first_line = text.split("\n", 1)[0]
    if first_line.count("\t") > first_line.count(","):
        return DataFormat.TSV
    if "," in first_line or ";" in first_line or suffix == ".txt":
        return DataFormat.CSV
    raise UnsupportedFormatError(f"could not recognize the format of {filename!r}")


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


# BOOLEAN is left out on purpose: DuckDB would turn labels like "yes"/"no" or "Y"/"N" into
# true/false, silently changing the user's values. Inference still reports such columns as
# boolean-like, and a cast step converts them explicitly.
_TYPE_CANDIDATES = "auto_type_candidates=['BIGINT', 'DOUBLE', 'DATE', 'TIMESTAMP', 'TIME', 'VARCHAR']"


def relation_sql(path: Path, fmt: DataFormat, encoding: str = "utf-8") -> str:
    """A DuckDB table expression that reads the file."""
    p = _sql_str(str(path))
    if fmt == DataFormat.CSV:
        enc = "utf-8" if encoding == "utf-8-sig" else encoding
        return f"read_csv({p}, header=true, sample_size=20480, encoding={_sql_str(enc)}, {_TYPE_CANDIDATES})"
    if fmt == DataFormat.TSV:
        return f"read_csv({p}, header=true, delim='\\t', sample_size=20480, {_TYPE_CANDIDATES})"
    if fmt == DataFormat.JSON:
        return f"read_json_auto({p}, format='array')"
    if fmt == DataFormat.JSONL:
        return f"read_json_auto({p}, format='newline_delimited')"
    if fmt == DataFormat.PARQUET:
        return f"read_parquet({p})"
    raise UnsupportedFormatError(f"{fmt.value} is not readable through DuckDB")


def _connect() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(":memory:")


def load_frame(path: Path, fmt: DataFormat, encoding: str = "utf-8", limit: int | None = None) -> pd.DataFrame:
    if fmt == DataFormat.XLSX:
        frame = pd.read_excel(path, engine="openpyxl", nrows=limit)
        return frame
    con = _connect()
    try:
        sql = f"SELECT * FROM {relation_sql(path, fmt, encoding)}"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        return con.execute(sql).df()
    except duckdb.Error as exc:
        raise UnsupportedFormatError(f"could not parse file as {fmt.value}: {exc}") from exc
    finally:
        con.close()


def load_sample(path: Path, fmt: DataFormat, encoding: str = "utf-8") -> pd.DataFrame:
    """First N rows plus a reservoir sample of the whole file (ING-NFR-002)."""
    if fmt == DataFormat.XLSX:
        return pd.read_excel(path, engine="openpyxl", nrows=settings.inference_head_rows + settings.inference_reservoir_rows)
    con = _connect()
    try:
        rel = relation_sql(path, fmt, encoding)
        head = con.execute(f"SELECT * FROM {rel} LIMIT {settings.inference_head_rows}").df()
        total = con.execute(f"SELECT count(*) FROM {rel}").fetchone()[0]
        if total <= settings.inference_head_rows:
            return head
        rest = con.execute(f"SELECT * FROM {rel} USING SAMPLE reservoir({settings.inference_reservoir_rows} ROWS) REPEATABLE (7)").df()
        return pd.concat([head, rest], ignore_index=True)
    except duckdb.Error as exc:
        raise UnsupportedFormatError(f"could not parse file as {fmt.value}: {exc}") from exc
    finally:
        con.close()


def is_xlsx(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as zf:
            return "[Content_Types].xml" in zf.namelist()
    except zipfile.BadZipFile:
        return False
