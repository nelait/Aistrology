"""GEN-006 distributions, GEN-009 anomaly injection, GEN-008a XML export."""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest
from defusedxml import ElementTree as SafeET
from pydantic import ValidationError

from app.generation.export import ExportFormat, export_frame
from app.generation.generator import GenerationError, GenerationOptions, generate, preview
from app.schema.model import Entity, Field, FieldType, Schema


def _schema() -> Schema:
    return Schema(
        name="s",
        entities=[
            Entity(
                name="people",
                fields=[
                    Field(name="id", type=FieldType.INTEGER, primary_key=True),
                    Field(name="height", type=FieldType.NUMBER, minimum=100, maximum=220, nullable=False),
                    Field(name="income", type=FieldType.INTEGER, minimum=0, maximum=500_000, nullable=False),
                    Field(name="visits", type=FieldType.INTEGER, minimum=0, nullable=False),
                    Field(name="tier", enum=["bronze", "silver", "gold"], nullable=False),
                    Field(name="country", nullable=False),
                    Field(name="joined", type=FieldType.DATE, nullable=False),
                    Field(name="note", nullable=False),
                ],
            )
        ],
    )


DISTS = {
    "people.height": {"kind": "normal", "mean": 170, "std": 10},
    "people.income": {"kind": "lognormal", "sigma": 1.0},
    "people.visits": {"kind": "lognormal", "mean": 1.0, "sigma": 0.5},
    "people.tier": {"kind": "weights", "weights": {"bronze": 8, "silver": 2}},
    "people.country": {"kind": "weights", "weights": {"US": 3, "DE": 1}},
}


def test_distributions_shape_and_bounds():
    frames = generate(_schema(), GenerationOptions(count=5000, seed=7, distributions=DISTS))
    df = frames["people"]
    h = df["height"].astype(float)
    assert 168 < h.mean() < 172 and 8 < h.std() < 12
    assert h.min() >= 100 and h.max() <= 220
    income = df["income"].astype(float)
    assert income.min() >= 0 and income.max() <= 500_000
    assert income.mean() > income.median() * 1.1  # right-skewed
    assert set(df["tier"]) == {"bronze", "silver"}  # gold has weight 0
    assert 0.75 < (df["tier"] == "bronze").mean() < 0.85
    assert set(df["country"]) == {"US", "DE"} and 0.7 < (df["country"] == "US").mean() < 0.8
    assert all(isinstance(v, int) for v in df["visits"].head(20)) and df["visits"].min() >= 0


def test_distributions_are_deterministic_and_prefix_stable():
    opts = GenerationOptions(count=400, seed=11, distributions=DISTS, null_rate=0.1)
    a = generate(_schema(), opts)["people"]
    b = generate(_schema(), opts)["people"]
    assert a.equals(b)
    head = preview(_schema(), opts)["people"]
    assert head.equals(a.head(len(head)))
    # Adding a distribution to one field leaves every other column unchanged.
    plain = generate(_schema(), GenerationOptions(count=400, seed=11, null_rate=0.1))["people"]
    for col in ("id", "joined", "note"):
        assert a[col].equals(plain[col])


def test_distribution_validation():
    with pytest.raises(ValidationError):
        GenerationOptions(distributions={"no_dot": {"kind": "normal"}})
    with pytest.raises(ValidationError):
        GenerationOptions(distributions={"people.tier": {"kind": "weights", "weights": {"a": -1}}})
    with pytest.raises(ValidationError):
        GenerationOptions(distributions={"people.height": {"kind": "normal", "std": 0}})
    with pytest.raises(GenerationError, match="not a field"):
        generate(_schema(), GenerationOptions(count=5, distributions={"people.nope": {"kind": "normal"}}))
    with pytest.raises(GenerationError, match="not in the enum"):
        generate(_schema(), GenerationOptions(count=5, distributions={"people.tier": {"kind": "weights", "weights": {"platinum": 1}}}))
    with pytest.raises(GenerationError, match="integer and number"):
        generate(_schema(), GenerationOptions(count=5, distributions={"people.note": {"kind": "normal"}}))
    # Weights on a numeric field without an enum: keys are coerced.
    df = generate(_schema(), GenerationOptions(count=50, distributions={"people.visits": {"kind": "weights", "weights": {"1": 1, "5": 1}}}))
    assert set(df["people"]["visits"]) <= {1, 5}


def test_anomaly_injection():
    base = GenerationOptions(count=2000, seed=3, null_rate=0)
    clean = generate(_schema(), base)["people"]
    dirty = generate(_schema(), base.model_copy(update={"anomaly_rate": 0.05}))["people"]
    assert clean["id"].equals(dirty["id"])  # primary keys are never corrupted
    out_of_range = ((dirty["height"] > 220) | (dirty["height"] < 100) | (dirty["height"].isin([0, -1]))).mean()
    assert 0.02 < out_of_range < 0.08
    odd_dates = dirty["joined"].isin([date(1900, 1, 1), date(2099, 12, 31), date(1970, 1, 1)]).mean()
    assert 0.02 < odd_dates < 0.08
    changed = (clean["note"] != dirty["note"]).mean()
    assert 0.02 < changed < 0.08
    # Non-anomalous values are identical to the clean run (a separate RNG stream).
    same = clean["height"] == dirty["height"]
    assert same.mean() > 0.9
    again = generate(_schema(), base.model_copy(update={"anomaly_rate": 0.05}))["people"]
    assert dirty.equals(again)
    with pytest.raises(ValidationError):
        GenerationOptions(anomaly_rate=0.9)


def test_xml_export_round_trips_through_ingestion(tmp_path):
    from app.ingestion.converters import convert_xml

    frames = generate(_schema(), GenerationOptions(count=25, seed=1))
    data = export_frame("people", frames["people"], ExportFormat.XML)
    root = SafeET.fromstring(data)
    assert root.tag == "people" and len(root) == 25 and root[0].tag == "row"
    src = tmp_path / "people.xml"
    src.write_bytes(data)
    rows, _ = convert_xml(src, tmp_path / "people.parquet")
    assert rows == 25
    import pandas as pd

    back = pd.read_parquet(tmp_path / "people.parquet")
    assert list(back["id"].astype(int)) == list(frames["people"]["id"])


def test_xml_export_sanitizes_names_and_values():
    import pandas as pd

    frame = pd.DataFrame({"1st col": ["a<b&c", None], "xmlish": [np.int64(3), 4], "tags": [["x", "y"], []]})
    data = export_frame("my table", frame, ExportFormat.XML).decode()
    assert "<my_table>" in data and "<_1st_col>a&lt;b&amp;c</_1st_col>" in data and "<_xmlish>3</_xmlish>" in data
    assert "<tags><item>x</item><item>y</item></tags>" in data
    SafeET.fromstring(data.encode())
