"""Schema evolution when new files arrive for an existing dataset (INF-007, INF-008).

A new file becomes the next immutable version of the dataset:

* ``append`` (default): rows of the new file are appended to the matching table of
  the latest version (``UNION ALL BY NAME``: new columns are added, missing ones
  become null, conflicting types are widened by DuckDB). Tables not in the new
  file are carried over unchanged.
* ``replace``: the new file's tables replace the old ones.

A single-table dataset keeps its table name whatever the new file is called.
The new version's schema is inferred, merged with the confirmed schema of the
previous version (unchanged columns keep their confirmed definitions and
annotations) and compared structurally: added, removed and retyped columns.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Literal

import duckdb
import pandas as pd

from ..schema.diff import SchemaDiff, diff_schemas
from ..schema.model import Entity, Schema
from ..storage.datasets import DatasetRecord, DatasetStore, TableRecord
from .formats import DataFormat, UnsupportedFormatError, relation_sql
from .prepare import PreparedTable, PreparedUpload

EvolutionMode = Literal["append", "replace"]


def _relation(con: duckdb.DuckDBPyConnection, alias: str, path: Path, fmt: DataFormat, encoding: str) -> str:
    if fmt == DataFormat.XLSX:
        con.register(alias, pd.read_excel(path, engine="openpyxl"))
        return alias
    return relation_sql(path, fmt, encoding)


def _union(old: Path, old_fmt: DataFormat, old_enc: str, new: PreparedTable, out: Path) -> int:
    con = duckdb.connect(":memory:", config={"threads": 2})
    try:
        a = _relation(con, "__old", old, old_fmt, old_enc)
        b = _relation(con, "__new", new.path, new.format, new.encoding)
        con.execute(f"CREATE TABLE u AS SELECT * FROM {a} UNION ALL BY NAME SELECT * FROM {b}")
        con.execute(f"COPY u TO '{str(out).replace(chr(39), chr(39) * 2)}' (FORMAT parquet)")
        return int(con.execute("SELECT count(*) FROM u").fetchone()[0])
    except duckdb.Error as exc:
        raise UnsupportedFormatError(f"could not append the new file to table {new.name!r}: {str(exc).splitlines()[0]}") from exc
    finally:
        con.close()


def make_transform(store: DatasetStore, previous: DatasetRecord, mode: EvolutionMode):
    """A ``transform`` for :meth:`DatasetStore.ingest_file` that aligns the new tables with ``previous``."""

    def transform(prepared: PreparedUpload) -> PreparedUpload:
        tables = list(prepared.tables)
        if len(previous.tables) == 1 and len(tables) == 1:
            tables[0].name = previous.tables[0].name
        if mode == "replace":
            return PreparedUpload(tables=tables, archive=prepared.archive)
        work = tables[0].path.parent / f"evolve-{uuid.uuid4().hex}"
        work.mkdir(parents=True, exist_ok=True)
        by_name = {t.name: t for t in tables}
        out: list[PreparedTable] = []
        for old in previous.tables:
            old_path = store.table_path(previous, old)
            new = by_name.pop(old.name, None)
            if new is None:
                copy = work / f"carry-{old.name}{old_path.suffix}"
                shutil.copyfile(old_path, copy)
                out.append(_carried(old, copy))
                continue
            merged = work / f"{old.name}.parquet"
            rows = _union(old_path, old.format, old.encoding, new, merged)
            new.notes.append(f"{new.name}: appended {new.original_filename} to the {old.name} table of version {previous.version}")
            new.path, new.format, new.encoding, new.row_count = merged, DataFormat.PARQUET, "binary", rows
            out.append(new)
        out.extend(by_name.values())  # tables that are new in this version
        return PreparedUpload(tables=out, archive=prepared.archive or ("merged" if len(out) > 1 else None))

    return transform


def _carried(old: TableRecord, path: Path) -> PreparedTable:
    return PreparedTable(
        name=old.name,
        path=path,
        format=old.format,
        encoding=old.encoding,
        original_filename=old.original_filename or old.name,
        source_format=old.source_format,
        source_encoding=old.source_encoding,
        row_count=old.row_count,
        notes=[f"{old.name}: carried over unchanged"],
    )


def _structural(schema: Schema) -> Schema:
    reset = {k: None for k in ("minimum", "maximum", "enum", "min_length", "max_length", "role", "semantic", "references")}
    return Schema(
        name=schema.name,
        entities=[
            Entity(
                name=e.name,
                fields=[
                    f.model_copy(update={**reset, "pii": False, "unique": False, "primary_key": False, "annotations": []}) for f in e.fields
                ],
            )
            for e in schema.entities
        ],
    )


def _align_single(old: Schema, new: Schema) -> Schema:
    if len(old.entities) == 1 and len(new.entities) == 1 and old.entities[0].name != new.entities[0].name:
        return new.model_copy(update={"entities": [new.entities[0].model_copy(update={"name": old.entities[0].name})]})
    return new


def evolution_diff(old: Schema | None, new: Schema) -> SchemaDiff:
    """Structural diff (added / removed / retyped columns and nullability) between versions (INF-007/008)."""
    old = old or Schema(name=new.name, entities=[])
    return diff_schemas(_structural(old), _structural(_align_single(old, new)))


def merge_confirmed(old: Schema | None, new: Schema) -> Schema:
    """Keep the previous version's confirmed field definitions for columns whose type is unchanged."""
    if old is None:
        return new
    new = _align_single(old, new)
    entities = []
    for e in new.entities:
        prev = old.entity(e.name)
        fields = []
        for f in e.fields:
            p = prev.field(f.name) if prev else None
            if p is not None and p.type == f.type and p.items_type == f.items_type:
                # The new data may contain nulls where the old didn't: never keep a stricter nullability.
                fields.append(p.model_copy(update={"nullable": p.nullable or f.nullable}) if not p.primary_key else p)
            else:
                fields.append(f)
        entities.append(e.model_copy(update={"fields": fields}))
    merged = new.model_copy(update={"entities": entities})
    # Drop references to entities or fields that no longer exist.
    for e in merged.entities:
        for i, f in enumerate(e.fields):
            if f.references and (
                merged.entity(f.references.entity) is None or merged.entity(f.references.entity).field(f.references.field) is None
            ):
                e.fields[i] = f.model_copy(update={"references": None})
    return merged
