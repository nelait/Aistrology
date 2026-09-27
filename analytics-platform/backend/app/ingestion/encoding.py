"""Character-encoding detection and conversion to UTF-8 on ingest (CLN-009, ING-009).

Text files are stored as UTF-8 so every downstream reader (DuckDB, pandas, the
LLM layer) sees one encoding. The original encoding is recorded on the table
(``TableRecord.source_encoding``) and the untouched raw file is kept (ING-010).

Detection order: byte-order marks, then a strict streaming UTF-8 check of the
whole file, then ``charset-normalizer`` on a sample — trusted for multi-byte and
non-Latin code pages (Shift-JIS, GBK, Windows-1251, …). For Latin-script text,
where statistical detectors misfire on short samples, the Western code pages are
scored by how plausible their decoding looks (letters vs. mojibake symbols), with
Windows-1252 winning ties. Latin-1 is the last resort (it decodes any byte sequence).
"""

from __future__ import annotations

import codecs
import unicodedata
from pathlib import Path

CHUNK = 1024 * 1024
SAMPLE_BYTES = 2 * 1024 * 1024

_BOMS = [
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
]


class EncodingTooLarge(ValueError):
    pass


def _decodes(path: Path, encoding: str, limit: int | None = None) -> bool:
    decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
    read = 0
    try:
        with path.open("rb") as fh:
            while chunk := fh.read(CHUNK):
                decoder.decode(chunk)
                read += len(chunk)
                if limit is not None and read >= limit:
                    return True
            decoder.decode(b"", final=True)
    except (UnicodeDecodeError, LookupError):
        return False
    return True


def _normalize(name: str) -> str:
    try:
        return codecs.lookup(name).name
    except LookupError:
        return name


# Multi-byte and non-Latin code pages: when charset-normalizer picks one of these it is reliable.
_TRUSTED_GUESSES = {
    _normalize(n)
    for n in (
        "shift_jis", "cp932", "euc_jp", "iso2022_jp", "gb2312", "gbk", "gb18030", "big5", "big5hkscs", "euc_kr", "cp949",
        "cp1251", "koi8_r", "koi8_u", "iso8859_5", "mac_cyrillic", "cp866", "cp1253", "iso8859_7", "cp1255", "iso8859_8",
        "cp1256", "iso8859_6", "cp874", "tis_620", "utf_16", "utf_32",
    )
}  # fmt: skip


def _plausibility(sample: bytes, encoding: str) -> float:
    """Share of non-ASCII characters that are letters, minus a penalty for symbols/controls (mojibake)."""
    try:
        text = sample.decode(encoding, errors="strict")
    except UnicodeDecodeError as exc:
        if exc.start < len(sample) - 4:  # a multi-byte sequence cut at the end of the sample is fine
            return float("-inf")
        text = sample[: exc.start].decode(encoding, errors="ignore")
    except LookupError:
        return float("-inf")
    odd = [ch for ch in text if ord(ch) > 127]
    if not odd:
        return 0.0
    letters = sum(unicodedata.category(ch).startswith("L") for ch in odd)
    bad = sum(unicodedata.category(ch) in ("Cc", "Co", "Cn", "So", "No", "Sk") and ch not in "€£¥©®°±µ·" for ch in odd)
    return (letters - 2 * bad) / len(odd)


def sniff_encoding(path: Path) -> str:
    """The text encoding of a file, as a Python codec name (``utf-8``, ``utf-8-sig``, ``cp1252``, ``shift_jis``, …)."""
    with path.open("rb") as fh:
        head = fh.read(SAMPLE_BYTES)
    for bom, name in _BOMS:
        if head.startswith(bom):
            return name
    if _decodes(path, "utf-8"):
        return "utf-8"
    guess = None
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(head).best()
        guess = _normalize(best.encoding) if best is not None else None
    except ImportError:  # pragma: no cover - charset-normalizer is a dependency
        guess = None
    if guess in _TRUSTED_GUESSES and _decodes(path, guess):
        return guess
    # For Latin-script text, statistical detectors are unreliable on short samples (cp1252 text is often
    # reported as cp775 or cp1250). Score the plausible Western code pages instead; ties go to cp1252.
    candidates = ["cp1252", *([guess] if guess and guess not in ("utf-8", "ascii") else []), "cp1250", "iso8859-15"]
    scored = [(_plausibility(head, c), -i, c) for i, c in enumerate(dict.fromkeys(candidates))]
    for _, _, candidate in sorted(scored, reverse=True):
        if _plausibility(head, candidate) > float("-inf") and _decodes(path, candidate):
            return candidate
    return "latin-1"  # latin-1 decodes every byte sequence


def needs_transcoding(encoding: str) -> bool:
    """UTF-8 (with or without BOM) and ASCII are read as-is; everything else is converted."""
    return _normalize(encoding) not in ("utf-8", "ascii") and encoding != "utf-8-sig"


def transcode_to_utf8(src: Path, dst: Path, encoding: str, *, max_bytes: int) -> int:
    """Stream ``src`` from ``encoding`` into UTF-8 at ``dst`` (BOM dropped). Returns bytes written.

    Raises EncodingTooLarge when the UTF-8 output exceeds ``max_bytes`` (UTF-8 can be up to
    twice the size of a single-byte encoding, and the dataset limit applies to what is stored).
    """
    decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
    written = 0
    first = True
    with src.open("rb") as fin, dst.open("wb") as fout:
        while True:
            chunk = fin.read(CHUNK)
            text = decoder.decode(chunk, final=not chunk)
            if first and text.startswith("﻿"):
                text = text[1:]
            if text:
                first = False
                data = text.encode("utf-8")
                written += len(data)
                if written > max_bytes:
                    raise EncodingTooLarge(f"file exceeds the {max_bytes / 1024**3:.0f} GB limit after conversion to UTF-8")
                fout.write(data)
            if not chunk:
                break
    return written
