from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from pydantic import TypeAdapter, ValidationError

from app.cleaning.steps import (
    Cast,
    Deduplicate,
    Derive,
    DropColumns,
    DropMissing,
    FillMissing,
    Filter,
    HandleOutliers,
    MaskPII,
    MergeColumns,
    NormalizeDates,
    NormalizeStrings,
    Rename,
    Reorder,
    SplitColumn,
    Step,
    StepError,
    pipeline_hash,
    run_steps,
)
from app.schema.model import Semantic


@pytest.fixture
def df():
    return pd.DataFrame(
        {
            "name": ["  Ada Lovelace ", "alan TURING", None, "Grace Hopper", "Grace Hopper"],
            "amount": [10.0, None, 30.0, 1000.0, 1000.0],
            "qty": ["1", "2", "x", "4", "4"],
            "when": ["2024-01-05", "05/02/2024", "not a date", "2024-03-01", "2024-03-01"],
            "email": ["ada@x.io", "alan@x.io", None, "grace@x.io", "grace@x.io"],
        }
    )


def test_input_is_never_mutated(df):
    before = df.copy()
    steps = [
        FillMissing(strategy="mean", columns=["amount"]),
        NormalizeStrings(case="lower"),
        Deduplicate(),
        Cast(column="qty", to="integer"),
    ]
    run_steps(df, steps)
    pd.testing.assert_frame_equal(df, before)


def test_missing_values(df):
    assert len(DropMissing().apply(df)) == 3
    assert list(DropMissing(axis="columns", max_null_fraction=0.1).apply(df).columns) == ["qty", "when"]
    assert FillMissing(strategy="median", columns=["amount"]).apply(df)["amount"].isna().sum() == 0
    assert FillMissing(strategy="constant", columns=["name"], value="unknown").apply(df)["name"][2] == "unknown"
    assert FillMissing(strategy="ffill", columns=["amount"]).apply(df)["amount"][1] == 10.0
    assert FillMissing(strategy="interpolate", columns=["amount"]).apply(df)["amount"][1] == 20.0
    with pytest.raises(StepError, match="numeric"):
        FillMissing(strategy="mean", columns=["name"]).apply(df)
    with pytest.raises(StepError, match="unknown column"):
        FillMissing(strategy="mode", columns=["nope"]).apply(df)


def test_outliers():
    frame = pd.DataFrame({"v": [1.0, 2, 3, 2, 1, 2, 3, 100]})
    capped = HandleOutliers(columns=["v"], action="cap").apply(frame)
    assert capped["v"].max() < 100 and len(capped) == 8
    assert len(HandleOutliers(columns=["v"], action="remove").apply(frame)) == 7
    assert HandleOutliers(columns=["v"], action="flag").apply(frame)["v_is_outlier"].sum() == 1
    assert HandleOutliers(columns=["v"], method="zscore", threshold=2, action="remove").apply(frame)["v"].max() == 3


def test_dedup_cast_strings_dates(df):
    assert len(Deduplicate().apply(df)) == 4
    assert len(Deduplicate(columns=["email"], keep="last").apply(df)) == 4
    cast = Cast(column="qty", to="integer").apply(df)
    assert str(cast["qty"].dtype) == "Int64" and cast["qty"].isna().sum() == 1
    assert len(Cast(column="qty", to="integer", on_error="drop_row").apply(df)) == 4
    with pytest.raises(StepError, match="could not be cast"):
        Cast(column="qty", to="number", on_error="fail").apply(df)
    norm = NormalizeStrings(columns=["name"], case="title", collapse_whitespace=True).apply(df)
    assert norm["name"].tolist()[:2] == ["Ada Lovelace", "Alan Turing"] and pd.isna(norm["name"][2])
    regex = NormalizeStrings(columns=["email"], find=r"@x\.io$", replace="@example.com").apply(df)
    assert regex["email"][0] == "ada@example.com"
    with pytest.raises(ValidationError):
        NormalizeStrings(find="([")
    dates = NormalizeDates(column="when", formats=["%Y-%m-%d", "%d/%m/%Y"]).apply(df)
    assert dates["when"][1] == pd.Timestamp("2024-02-05") and pd.isna(dates["when"][2])


def test_column_operations(df):
    assert "full_name" in Rename(mapping={"name": "full_name"}).apply(df).columns
    with pytest.raises(StepError):
        Rename(mapping={"name": "bad name"}).apply(df)
    assert "email" not in DropColumns(columns=["email"]).apply(df).columns
    assert list(Reorder(columns=["email", "name"]).apply(df).columns)[:2] == ["email", "name"]
    split = SplitColumn(column="email", separator="@", into=["user", "domain"]).apply(df)
    assert split["user"][0] == "ada" and split["domain"][0] == "x.io"
    merged = MergeColumns(columns=["name", "email"], into="label", separator=" | ").apply(df)
    assert merged["label"][3] == "Grace Hopper | grace@x.io"


def test_derive_and_filter_expressions():
    frame = pd.DataFrame({"qty": [1, 2, 3], "price": [10.0, 5.0, 2.5], "region": ["east", "test", "west"]})
    derived = Derive(name="revenue", expression="qty * price").apply(frame)
    assert derived["revenue"].tolist() == [10.0, 10.0, 7.5]
    kept = Filter(condition="region <> 'test' AND qty >= 1").apply(frame)
    assert kept["region"].tolist() == ["east", "west"]
    assert Derive(name="bucket", expression="CASE WHEN price > 4 THEN 'high' ELSE 'low' END").apply(frame)["bucket"].tolist() == [
        "high",
        "high",
        "low",
    ]
    for bad in ["1; DROP TABLE t", "(SELECT 1)", "read_csv('/etc/passwd')", "qty -- comment"]:
        with pytest.raises(ValidationError):
            Derive(name="x", expression=bad)
    with pytest.raises(StepError):
        Filter(condition="nonexistent > 1").apply(frame)


def test_mask_pii(df):
    masked = MaskPII(columns=["email"], semantics={"email": Semantic.EMAIL}).apply(df)
    assert masked["email"][0] == "a***@x.io" and pd.isna(masked["email"][2])
    hashed = MaskPII(columns=["email"], strategy="hash", salt="s").apply(df)
    assert hashed["email"][3] == hashed["email"][4] != "grace@x.io"


def test_steps_serialize_and_hash_stably():
    adapter = TypeAdapter(list[Step])
    steps = adapter.validate_python([{"op": "fill_missing", "strategy": "mean", "columns": ["a"]}, {"op": "deduplicate"}])
    assert [s.op for s in steps] == ["fill_missing", "deduplicate"]
    assert pipeline_hash(steps) == pipeline_hash(adapter.validate_json(adapter.dump_json(steps)))
    with pytest.raises(ValidationError):
        adapter.validate_python([{"op": "rm_rf"}])


def test_run_steps_reports_stats(df):
    _, stats = run_steps(df, [DropMissing(), Derive(name="big", expression="amount > 100")])
    assert stats[0].rows_before == 5 and stats[0].rows_after == 3
    assert stats[1].added_columns == ["big"] and stats[1].changed_cells == 0
    with pytest.raises(StepError, match="step 1"):
        run_steps(df, [Cast(column="qty", to="integer", on_error="fail")])


def test_large_frame_performance():
    rng = np.random.default_rng(0)
    frame = pd.DataFrame({"a": rng.normal(size=100_000), "b": rng.integers(0, 10, 100_000)})
    frame.loc[::10, "a"] = None
    result, _ = run_steps(frame, [FillMissing(strategy="median", columns=["a"]), HandleOutliers(columns=["a"]), Filter(condition="b > 2")])
    assert result["a"].isna().sum() == 0 and (result["b"] > 2).all()
