"""Readers for the P1 formats — legacy Excel (.xls), Avro, ORC and XML (ING-003a).

DuckDB reads CSV/JSON/Parquet natively. These formats are converted once, at
ingest, into a Parquet working copy that every downstream module (profiling,
cleaning, the SQL sandbox) already understands; the original file is kept
unchanged as the raw file (ING-010).

XML is parsed with ``defusedxml`` (no DTDs, entities or external references,
SEC-011) using ``iterparse``, so memory stays proportional to one record.
Records are the repeated children of the root (or of the first element that
has repeated children). Each record is flattened: attributes and leaf children
become columns, nested elements become ``parent_child`` columns, and the first
group of repeated child elements is exploded into one row per child.
"""

from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

MAX_XML_DEPTH = 64


class ConversionError(ValueError):
    pass


def _scalar(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, default=_json_default, ensure_ascii=False)
    return value


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (UUID, bytes)):
        return str(value) if isinstance(value, UUID) else value.hex()
    return str(value)


def write_frame(frame: pd.DataFrame, dst: Path) -> int:
    """Write a frame as Parquet. Object columns with mixed types are stored as strings. Returns the row count."""
    frame = frame.copy()
    frame.columns = [str(c) for c in frame.columns]
    for col in frame.columns:
        if frame[col].dtype == object:
            frame[col] = frame[col].map(_scalar)
    try:
        table = pa.Table.from_pandas(frame, preserve_index=False)
    except (pa.ArrowInvalid, pa.ArrowTypeError, pa.ArrowNotImplementedError):
        for col in frame.columns:
            if frame[col].dtype == object:
                frame[col] = frame[col].map(lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v))
        table = pa.Table.from_pandas(frame, preserve_index=False)
    pq.write_table(table, dst)
    return len(frame)


def convert_xls(src: Path, dst: Path) -> tuple[int, list[str]]:
    try:
        sheets = pd.read_excel(src, engine="xlrd", sheet_name=None)
    except ImportError as exc:  # pragma: no cover - xlrd is a dependency
        raise ConversionError("reading .xls needs the xlrd package") from exc
    except Exception as exc:  # noqa: BLE001 - xlrd raises many error types for corrupt files
        raise ConversionError(f"could not read the .xls workbook: {exc}") from exc
    if not sheets:
        raise ConversionError("the .xls workbook has no sheets")
    name, frame = next(iter(sheets.items()))
    notes = [f"read the first sheet ({name!r}); {len(sheets) - 1} other sheet(s) ignored"] if len(sheets) > 1 else []
    return write_frame(frame, dst), notes


def convert_avro(src: Path, dst: Path) -> tuple[int, list[str]]:
    try:
        import fastavro
    except ImportError as exc:  # pragma: no cover - fastavro is a dependency
        raise ConversionError("reading Avro needs the fastavro package") from exc
    try:
        with src.open("rb") as fh:
            records = [{k: _scalar(v) for k, v in r.items()} for r in fastavro.reader(fh)]
    except Exception as exc:  # noqa: BLE001 - fastavro raises various errors on corrupt input
        raise ConversionError(f"could not read the Avro file: {exc}") from exc
    if records and not isinstance(records[0], dict):
        raise ConversionError("Avro records must be of record type")
    return write_frame(pd.DataFrame.from_records(records), dst), []


def convert_orc(src: Path, dst: Path) -> tuple[int, list[str]]:
    import pyarrow.orc as orc

    try:
        reader = orc.ORCFile(str(src))
        rows = 0
        with pq.ParquetWriter(dst, reader.schema) as writer:
            for i in range(reader.nstripes):
                stripe = reader.read_stripe(i)
                table = pa.Table.from_batches([stripe]) if isinstance(stripe, pa.RecordBatch) else stripe
                writer.write_table(table)
                rows += table.num_rows
    except (pa.ArrowException, OSError) as exc:
        raise ConversionError(f"could not read the ORC file: {exc}") from exc
    return rows, []


# -- XML ------------------------------------------------------------------------------------

_DTD_RE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


def _local(tag: Any) -> str:
    tag = str(tag)
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag.split(":")[-1]


def _text(el: ET.Element) -> str | None:
    t = (el.text or "").strip()
    return t or None


def _flatten(el: ET.Element, prefix: str, row: dict[str, Any], groups: list[tuple[str, list[ET.Element]]], depth: int = 0) -> None:
    """Flatten ``el``'s attributes and children into ``row``; collect repeated child groups."""
    if depth > MAX_XML_DEPTH:
        raise ConversionError("XML is nested too deeply")
    for key, value in el.attrib.items():
        row[f"{prefix}{_local(key)}"] = value
    children = list(el)
    if not children:
        text = _text(el)
        if prefix and (text is not None or not el.attrib):
            row[prefix.rstrip("_") if not el.attrib else f"{prefix}value"] = text
        return
    counts = Counter(_local(c.tag) for c in children)
    seen: set[str] = set()
    for child in children:
        tag = _local(child.tag)
        if counts[tag] > 1:
            if tag not in seen:
                seen.add(tag)
                groups.append((f"{prefix}{tag}", [c for c in children if _local(c.tag) == tag]))
            continue
        if len(child) == 0 and not child.attrib:
            row[f"{prefix}{tag}"] = _text(child)
        else:
            _flatten(child, f"{prefix}{tag}_", row, groups, depth + 1)


def _group_value(elements: list[ET.Element]) -> str:
    items: list[Any] = []
    for e in elements:
        if len(e) == 0 and not e.attrib:
            items.append(_text(e))
        else:
            sub: dict[str, Any] = {}
            nested: list[tuple[str, list[ET.Element]]] = []
            _flatten(e, "", sub, nested)
            for name, group in nested:
                sub[name] = json.loads(_group_value(group))
            items.append(sub)
    return json.dumps(items, ensure_ascii=False)


def _record_rows(record: ET.Element) -> tuple[list[dict[str, Any]], bool]:
    """Rows for one record element. Returns (rows, whether a second repeated group was JSON-encoded)."""
    base: dict[str, Any] = {}
    groups: list[tuple[str, list[ET.Element]]] = []
    _flatten(record, "", base, groups)
    if not groups:
        return [base], False
    (name, elements), rest = groups[0], groups[1:]
    for other_name, other in rest:
        base[other_name] = _group_value(other)
    rows = []
    for e in elements:
        row = dict(base)
        if len(e) == 0 and not e.attrib:
            row[name] = _text(e)
        else:
            nested: list[tuple[str, list[ET.Element]]] = []
            _flatten(e, f"{name}_", row, nested)
            for nested_name, group in nested:
                row[nested_name] = _group_value(group)
        rows.append(row)
    return rows, bool(rest)


def _iterparse(src: Path, events: tuple[str, ...]):
    import defusedxml.ElementTree as SafeET

    return SafeET.iterparse(str(src), events=events, forbid_dtd=True, forbid_entities=True, forbid_external=True)


def _record_level(src: Path, probe_elements: int = 5000) -> tuple[int, str | None]:
    """Depth and tag of the record elements: the shallowest level where sibling tags repeat."""
    depth = 0
    child_counts: list[Counter] = [Counter()]
    seen = 0
    try:
        for event, el in _iterparse(src, ("start", "end")):
            if event == "start":
                child_counts[depth][_local(el.tag)] += 1
                depth += 1
                if len(child_counts) <= depth:
                    child_counts.append(Counter())
                seen += 1
                if seen >= probe_elements:
                    break
            else:
                depth -= 1
                if depth <= 1:
                    el.clear()
    except ET.ParseError as exc:
        line, col = exc.position
        raise ConversionError(f"invalid XML at {line}:{col}: {exc}") from exc
    for level in range(1, len(child_counts)):
        repeated = [tag for tag, n in child_counts[level].items() if n > 1]
        if repeated:
            return level, max(repeated, key=lambda t: child_counts[level][t])
    return 1, None


def convert_xml(src: Path, dst: Path) -> tuple[int, list[str]]:
    with src.open("rb") as fh:
        head = fh.read(64 * 1024)
    if _DTD_RE.search(head):
        raise ConversionError("XML with DOCTYPE or ENTITY declarations is not allowed")
    from defusedxml import DefusedXmlException

    try:
        level, record_tag = _record_level(src)
        rows: list[dict[str, Any]] = []
        encoded_groups = False
        depth = 0
        for event, el in _iterparse(src, ("start", "end")):
            if event == "start":
                depth += 1
                continue
            depth -= 1
            if depth == level and (record_tag is None or _local(el.tag) == record_tag):
                record_rows, extra = _record_rows(el)
                rows.extend(record_rows)
                encoded_groups = encoded_groups or extra
                el.clear()
    except DefusedXmlException as exc:
        raise ConversionError(f"unsafe XML construct: {exc}") from exc
    except ET.ParseError as exc:
        line, col = exc.position
        raise ConversionError(f"invalid XML at {line}:{col}: {exc}") from exc
    if not rows:
        raise ConversionError("no records found in the XML document")
    notes = [f"XML records are <{record_tag}> elements" if record_tag else "XML has a single record"]
    if encoded_groups:
        notes.append("records have several repeated child groups: the first was exploded into rows, the others kept as JSON")
    return write_frame(pd.DataFrame.from_records(rows), dst), notes
