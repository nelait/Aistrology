"""Loading dataset versions as frames or sandbox tables. Shared by the API and job workers."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .ingestion.formats import DataFormat, load_frame
from .schema.model import column_renames
from .storage.datasets import DatasetRecord, DatasetStore, TableRecord


class MultiTableError(ValueError):
    pass


def main_table(record: DatasetRecord, table: str | None = None) -> TableRecord:
    if table is not None:
        for t in record.tables:
            if t.name == table:
                return t
        raise KeyError(f"table {table!r} not found")
    if len(record.tables) != 1:
        raise MultiTableError(f"dataset has {len(record.tables)} tables; pass table=<name> ({', '.join(t.name for t in record.tables)})")
    return record.tables[0]


def renames(record: DatasetRecord) -> dict[str, dict[str, str]]:
    """{table: {source column: canonical name}} for single-entity schemas of uploaded files."""
    if record.schema_ is None or len(record.tables) != 1 or len(record.schema_.entities) != 1:
        return {}
    return {record.tables[0].name: column_renames(record.schema_.entities[0])}


def load_table(store: DatasetStore, record: DatasetRecord, table: str | None = None, limit: int | None = None) -> pd.DataFrame:
    t = main_table(record, table)
    frame = load_frame(store.table_path(record, t), t.format, t.encoding, limit)
    return frame.rename(columns=renames(record).get(t.name, {}))


def sandbox_tables(store: DatasetStore, record: DatasetRecord) -> dict[str, tuple[Path, DataFormat, str]]:
    return {t.name: (store.table_path(record, t), t.format, t.encoding) for t in record.tables}
