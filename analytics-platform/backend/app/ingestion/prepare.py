"""Turn one uploaded (or imported) file into the dataset's tables (ING-003a, ING-006, CLN-009).

1. Archives (.zip / .gz / .tar / .tar.gz) are extracted safely; every data file
   in the archive becomes one table of the dataset.
2. Each file's format is detected. .xls / Avro / ORC / XML are converted to Parquet.
3. Text files in an encoding other than UTF-8 are transcoded to UTF-8.

A file that needs none of this passes through unchanged, so plain CSV/JSON/Parquet
uploads are stored exactly as before.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .archive import ArchiveError, extract
from .converters import ConversionError, convert_avro, convert_orc, convert_xls, convert_xml
from .encoding import EncodingTooLarge, needs_transcoding, sniff_encoding, transcode_to_utf8
from .formats import TEXT_FORMATS, DataFormat, UnsupportedFormatError, detect_format, is_xlsx

HEAD_BYTES = 64 * 1024

_CONVERTERS = {DataFormat.XLS: convert_xls, DataFormat.AVRO: convert_avro, DataFormat.ORC: convert_orc, DataFormat.XML: convert_xml}


@dataclass
class PreparedTable:
    name: str  # table name
    path: Path  # local file, ready to store
    format: DataFormat  # format of ``path``
    encoding: str
    original_filename: str
    source_format: DataFormat | None = None  # set when converted
    source_encoding: str | None = None  # set when transcoded
    row_count: int | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def transformed(self) -> bool:
        return self.source_format is not None or self.source_encoding is not None


@dataclass
class PreparedUpload:
    tables: list[PreparedTable]
    archive: str | None = None  # zip | gzip | tar | tar.gz

    @property
    def passthrough(self) -> bool:
        """True when the upload is stored as-is (a single, unconverted file)."""
        return self.archive is None and len(self.tables) == 1 and not self.tables[0].transformed


def table_name(filename: str) -> str:
    stem = Path(filename.replace("\\", "/")).name
    for suffix in (".gz", ".gzip"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
    stem = Path(stem).stem.lower()
    stem = re.sub(r"[^a-z0-9_]", "_", stem).strip("_") or "data"
    return f"t_{stem}" if stem[0].isdigit() else stem[:100]


def _prepare_file(path: Path, filename: str, work_dir: Path, max_bytes: int, index: int) -> PreparedTable:
    with path.open("rb") as fh:
        head = fh.read(HEAD_BYTES)
    if not head:
        raise ValueError(f"{filename}: file is empty")
    fmt = detect_format(filename, head)
    if fmt == DataFormat.XLSX and not is_xlsx(path):
        raise UnsupportedFormatError(f"{filename}: not a valid .xlsx workbook")
    table = PreparedTable(name=table_name(filename), path=path, format=fmt, encoding="binary", original_filename=filename)
    source = path
    if fmt == DataFormat.PARQUET:
        try:
            table.row_count = pq.ParquetFile(path).metadata.num_rows  # free: it's in the footer
        except (pa.ArrowException, OSError) as exc:
            raise UnsupportedFormatError(f"{filename}: not a valid Parquet file: {exc}") from exc
    if fmt in TEXT_FORMATS and fmt != DataFormat.XML:  # XML parsers honour the document's own encoding declaration
        encoding = sniff_encoding(path)
        if needs_transcoding(encoding):
            utf8 = work_dir / f"utf8-{index:03d}{path.suffix[:10]}"
            try:
                transcode_to_utf8(path, utf8, encoding, max_bytes=max_bytes)
            except UnicodeDecodeError as exc:  # pragma: no cover - sniff_encoding verified the whole file
                raise UnsupportedFormatError(f"{filename}: could not decode as {encoding}: {exc}") from exc
            except EncodingTooLarge as exc:
                raise UnsupportedFormatError(str(exc)) from exc
            table.source_encoding = encoding
            table.notes.append(f"{filename}: converted from {encoding} to UTF-8")
            source = utf8
            table.path = utf8
            table.encoding = "utf-8"
        else:
            table.encoding = "utf-8-sig" if encoding == "utf-8-sig" else "utf-8"
    if fmt in _CONVERTERS:
        out = work_dir / f"converted-{index:03d}.parquet"
        try:
            rows, notes = _CONVERTERS[fmt](source, out)
        except ConversionError as exc:
            raise UnsupportedFormatError(f"{filename}: {exc}") from exc
        table.source_format = fmt
        table.format = DataFormat.PARQUET
        table.encoding = "binary"
        table.path = out
        table.row_count = rows
        table.notes.extend(f"{filename}: {n}" for n in notes)
    return table


def prepare_upload(path: Path, filename: str, work_dir: Path, *, max_bytes: int) -> PreparedUpload:
    """Extract, detect, convert and transcode. Raises ArchiveError / UnsupportedFormatError / ValueError."""
    work_dir.mkdir(parents=True, exist_ok=True)
    kind, members = extract(path, filename, work_dir / "extracted", max_bytes=max_bytes)
    files = [(m.name, m.path) for m in members] if kind else [(filename, path)]
    tables: list[PreparedTable] = []
    taken: set[str] = set()
    errors: list[str] = []
    for i, (name, local) in enumerate(files):
        try:
            table = _prepare_file(local, name, work_dir, max_bytes, i)
        except (UnsupportedFormatError, ValueError) as exc:
            if not kind:
                raise
            errors.append(str(exc))
            continue
        base, n = table.name, 2
        while table.name in taken:
            table.name = f"{base}_{n}"
            n += 1
        taken.add(table.name)
        tables.append(table)
    if not tables:
        raise UnsupportedFormatError("; ".join(errors) or "no data files found")
    if errors:
        tables[0].notes.extend(f"skipped: {e}" for e in errors)
    return PreparedUpload(tables=tables, archive=kind)


__all__ = ["ArchiveError", "PreparedTable", "PreparedUpload", "prepare_upload", "table_name"]
