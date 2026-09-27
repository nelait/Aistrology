from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.ingestion.formats import DataFormat, UnsupportedFormatError, detect_encoding, detect_format, load_frame, load_sample
from app.ingestion.inference import infer_schema, normalize_name
from app.privacy import detect_value_semantic, mask_value, redact_text
from app.profiling.profile import profile_frame
from app.schema.model import ColumnRole, FieldType, Semantic

CSV = """Customer ID,Full Name,Contact,Signup Date,Zip,Plan,Monthly Spend,Active,Notes
1,Ada Lovelace,ada@example.com,03/15/2023,02139,pro,120.50,yes,
2,Alan Turing,alan@example.org,04/01/2023,94016,basic,20.00,no,likes tea
3,Grace Hopper,grace@example.net,12/25/2022,10001,pro,99.99,yes,
4,Linus T,linus@example.com,01/31/2024,00501,enterprise,1500.00,yes,vip
"""


def _write(tmp_path: Path, name: str, content: str | bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def test_format_and_encoding_detection():
    assert detect_format("x.csv", b"a,b\n1,2") == DataFormat.CSV
    assert detect_format("x.txt", b"a\tb\n1\t2") == DataFormat.TSV
    assert detect_format("x.json", b'[{"a":1}]') == DataFormat.JSON
    assert detect_format("x.json", b'{"a":1}\n{"a":2}\n') == DataFormat.JSONL
    assert detect_format("renamed.csv", b"PAR1....") == DataFormat.PARQUET
    # ING-003a: legacy .xls is supported now (converted to Parquet on ingest).
    assert detect_format("old.xls", b"\xd0\xcf\x11\xe0rest") == DataFormat.XLS
    with pytest.raises(UnsupportedFormatError, match="archive"):
        detect_format("nested.zip", b"PK\x03\x04rest")
    assert detect_encoding("naïve".encode()) == "utf-8"
    assert detect_encoding("naïve,café\n".encode("latin-1")) == "latin-1"
    assert detect_encoding(b"\xef\xbb\xbfa,b") == "utf-8-sig"


def test_infer_csv_columns(tmp_path):
    path = _write(tmp_path, "customers.csv", CSV)
    result = infer_schema(load_sample(path, DataFormat.CSV), entity_name="customers")
    fields = {f.name: f for f in result.schema_.entities[0].fields}
    cols = {c.name: c for c in result.columns}

    assert list(fields) == ["customer_id", "full_name", "contact", "signup_date", "zip", "plan", "monthly_spend", "active", "notes"]
    assert fields["customer_id"].primary_key and fields["customer_id"].source_name == "Customer ID"
    assert fields["full_name"].semantic == Semantic.FULL_NAME and fields["full_name"].pii
    # INF-009: detected from values, not the column name
    assert fields["contact"].semantic == Semantic.EMAIL and fields["contact"].pii
    # INF-002: US date strings detected with their format
    assert fields["signup_date"].type == FieldType.DATE
    assert fields["zip"].type == FieldType.STRING  # leading zeros are kept, not parsed as numbers
    assert fields["monthly_spend"].type == FieldType.NUMBER
    assert fields["active"].type == FieldType.BOOLEAN
    assert fields["notes"].nullable
    assert cols["customer_id"].role == ColumnRole.IDENTIFIER


def test_string_dates_and_ambiguity():
    frame = pd.DataFrame({"d": ["2024-01-05", "2024-02-11", "2023-12-31"], "amb": ["01/02/2024", "03/04/2024", "05/06/2024"]})
    result = infer_schema(frame)
    cols = {c.name: c for c in result.columns}
    assert cols["d"].type == FieldType.DATE
    assert cols["amb"].type == FieldType.DATE and cols["amb"].ambiguous_formats
    assert any("ambiguous" in w for w in result.warnings)


def test_json_and_parquet_loading(tmp_path):
    frame = pd.DataFrame({"id": [1, 2, 3], "score": [0.5, None, 2.5], "tags": ["a", "b", None]})
    frame.to_parquet(tmp_path / "t.parquet")
    _write(tmp_path, "t.jsonl", frame.to_json(orient="records", lines=True))
    _write(tmp_path, "t.json", frame.to_json(orient="records"))
    for name, fmt in [("t.parquet", DataFormat.PARQUET), ("t.jsonl", DataFormat.JSONL), ("t.json", DataFormat.JSON)]:
        loaded = load_frame(tmp_path / name, fmt)
        assert len(loaded) == 3
        fields = {f.name: f for f in infer_schema(loaded).schema_.entities[0].fields}
        assert fields["id"].type == FieldType.INTEGER and fields["id"].primary_key
        assert fields["score"].type == FieldType.NUMBER and fields["score"].nullable


def test_xlsx_loading(tmp_path):
    pd.DataFrame({"a": [1, 2], "b": ["x", "y"]}).to_excel(tmp_path / "t.xlsx", index=False)
    assert load_frame(tmp_path / "t.xlsx", DataFormat.XLSX).shape == (2, 2)


def test_normalize_name_is_unique_and_valid():
    taken: set[str] = set()
    assert [normalize_name(n, taken) for n in ["Order Date", "order_date", "2nd col", "", "custID"]] == [
        "order_date",
        "order_date_2",
        "c_2nd_col",
        "column",
        "cust_id",
    ]


def test_profile_statistics_and_quality():
    rng = np.random.default_rng(0)
    values = rng.normal(100, 10, 1000).tolist() + [1000.0]  # one obvious outlier
    frame = pd.DataFrame(
        {
            "value": values,
            "category": (["a", "b", None] * 334)[:1001],
            "numeric_text": [str(i) for i in range(1001)],
        }
    )
    frame = pd.concat([frame, frame.head(5)], ignore_index=True)  # 5 exact duplicates
    schema = infer_schema(frame).schema_
    profile = profile_frame(frame, schema)
    value = next(c for c in profile.columns if c.name == "value")
    assert value.outliers.iqr_count >= 1 and value.outliers.zscore_count >= 1
    assert value.percentiles["p50"] == pytest.approx(np.median(frame["value"]))
    assert sum(value.histogram.counts) == len(frame)
    category = next(c for c in profile.columns if c.name == "category")
    assert category.null_count > 0 and category.top_values[0][1] > 0
    assert profile.duplicate_row_count == 5
    assert 0 < profile.quality.score < 100
    assert profile.quality.uniqueness == pytest.approx(1 - 5 / len(frame), abs=1e-4)


def test_profile_flags_numbers_stored_as_text():
    frame = pd.DataFrame({"amount": ["10", "20", "x", "40"] * 10})
    profile = profile_frame(frame)
    assert "mixed types" in profile.columns[0].type_mismatch
    assert profile.quality.validity < 1


def test_pii_helpers():
    assert detect_value_semantic(["a@b.co", "c@d.io", "e@f.net"]) == Semantic.EMAIL
    assert detect_value_semantic(["4111 1111 1111 1111", "4012888888881881"]) == Semantic.CREDIT_CARD
    assert detect_value_semantic(["12345", "67890"]) is None  # bare numbers are not phone numbers
    assert detect_value_semantic(["+1 (415) 555-0100", "415-555-0199"]) == Semantic.PHONE
    text = "mail ada@example.com, ssn 123-45-6789, card 4111 1111 1111 1111, ip 10.0.0.1, call 415-555-0100"
    redacted = redact_text(text)
    for secret in ["ada@example.com", "123-45-6789", "4111 1111 1111 1111", "10.0.0.1", "415-555-0100"]:
        assert secret not in redacted
    assert mask_value("ada@example.com", Semantic.EMAIL) == "a***@example.com"
    assert mask_value("123-45-6789", Semantic.SSN) == "***6789"
