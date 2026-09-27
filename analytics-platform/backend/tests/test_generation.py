from __future__ import annotations

import hashlib
import io
import json
import re
import time
import zipfile
from types import SimpleNamespace

import pandas as pd
import pyarrow.parquet as pq
import pytest

from app.generation import generator
from app.generation.export import ExportFormat, export_frame, export_zip
from app.generation.generator import GenerationError, GenerationOptions, GenerationTooLarge, check_size, generate, plan_counts, preview
from app.generation.values import UnsupportedPattern, compile_pattern, pattern_values
from app.privacy import luhn_ok
from app.schema.model import Entity, Field, FieldType, ForeignKey, Schema, Semantic


def _digest(frames: dict[str, pd.DataFrame]) -> str:
    return hashlib.sha256(b"".join(export_frame(n, f, ExportFormat.CSV) for n, f in frames.items())).hexdigest()


def test_seeded_generation_is_reproducible(shop_schema):
    opts = GenerationOptions(count=500, seed=7)
    assert _digest(generate(shop_schema, opts)) == _digest(generate(shop_schema, opts))
    assert _digest(generate(shop_schema, opts)) != _digest(generate(shop_schema, opts.model_copy(update={"seed": 8})))


def test_adding_a_field_does_not_change_other_columns(shop_schema):
    opts = GenerationOptions(count=100, seed=1)
    before = generate(shop_schema, opts)["customers"]
    extended = shop_schema.model_copy(deep=True)
    extended.entity("customers").fields.append(Field(name="loyalty_points", type=FieldType.INTEGER))
    after = generate(extended, opts)["customers"]
    pd.testing.assert_frame_equal(before, after.drop(columns=["loyalty_points"]))


def test_constraints_and_referential_integrity(shop_schema):
    frames = generate(shop_schema, GenerationOptions(count=2000, seed=3, null_rate=0.1))
    customers, orders = frames["customers"], frames["orders"]
    assert len(customers) == 2000
    assert customers["id"].is_unique and customers["id"].notna().all()
    assert customers["email"].is_unique and customers["email"].notna().all()
    assert customers["email"].str.match(r"^[^@]+@[^@]+\.[a-z]+$").all()
    assert set(customers["tier"].dropna()) <= {"bronze", "silver", "gold"}
    assert customers["tier"].isna().any()  # nullable fields get nulls at null_rate
    assert customers["address_postal_code"].dropna().str.fullmatch(r"[0-9]{5}").all()
    # GEN-005: every FK resolves, and the FK column itself is never null
    assert orders["customer_id"].notna().all()
    assert set(orders["customer_id"]) <= set(customers["id"])
    assert orders["order_id"].is_unique
    assert orders["order_id"].str.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").all()
    assert orders["quantity"].between(1, 20).all()
    assert (orders["total_price"] >= 0).all()
    assert orders["total_price"].notna().all()  # required


def test_preview_is_a_prefix_of_full_generation(shop_schema):
    opts = GenerationOptions(count=300, seed=11)
    full, head = generate(shop_schema, opts), preview(shop_schema, opts)
    assert len(head["customers"]) == generator.PREVIEW_ROWS
    pd.testing.assert_frame_equal(head["customers"], full["customers"].head(generator.PREVIEW_ROWS))


def test_explicit_counts_and_fanout(shop_schema):
    planned = plan_counts(shop_schema, GenerationOptions(count=100, children_per_parent=(2, 2)))
    assert planned == {"customers": 100, "orders": 200}
    frames = generate(shop_schema, GenerationOptions(count=100, children_per_parent=(2, 2)))
    assert (frames["orders"]["customer_id"].value_counts() == 2).all()
    frames = generate(shop_schema, GenerationOptions(count=10, counts={"orders": 37}))
    assert len(frames["orders"]) == 37


def test_self_reference_and_semantic_values():
    schema = Schema(
        entities=[
            Entity(
                name="employees",
                fields=[
                    Field(name="id", type=FieldType.INTEGER, primary_key=True),
                    Field(name="manager_id", type=FieldType.INTEGER, references=ForeignKey(entity="employees", field="id")),
                    Field(name="card", semantic=Semantic.CREDIT_CARD),
                    Field(name="ssn", semantic=Semantic.SSN, nullable=False),
                ],
            )
        ]
    )
    df = generate(schema, GenerationOptions(count=200, null_rate=0))["employees"]
    assert pd.isna(df.loc[0, "manager_id"])
    assert (df["manager_id"].dropna() < df["id"][1:]).all()
    assert all(luhn_ok(c) for c in df["card"])
    assert df["ssn"].str.match(r"^9\d\d-").all()  # never a real SSN range


def test_unique_integer_range_too_small():
    schema = Schema(entities=[Entity(name="t", fields=[Field(name="code", type=FieldType.INTEGER, unique=True, minimum=1, maximum=5)])])
    with pytest.raises(GenerationError, match="too small"):
        generate(schema, GenerationOptions(count=10))


def test_size_limit(shop_schema, monkeypatch):
    monkeypatch.setattr(generator, "settings", SimpleNamespace(max_dataset_bytes=50_000))
    with pytest.raises(GenerationTooLarge) as exc:
        check_size(shop_schema, GenerationOptions(count=5000))
    assert 0 < exc.value.max_count < 5000
    assert check_size(shop_schema, GenerationOptions(count=exc.value.max_count // 2)) <= 50_000


def test_100k_rows_within_budget(shop_schema):
    started = time.perf_counter()
    frames = generate(shop_schema, GenerationOptions(count=40_000, children_per_parent=(1, 2)))
    elapsed = time.perf_counter() - started
    assert sum(len(f) for f in frames.values()) >= 100_000
    assert elapsed < 30, f"SCH-NFR-002 budget exceeded: {elapsed:.1f}s"


@pytest.mark.parametrize("fmt", list(ExportFormat))
def test_exports(shop_schema, fmt):
    frames = generate(shop_schema, GenerationOptions(count=20, seed=5))
    data = export_zip(frames, fmt)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = sorted(zf.namelist())
        assert names == sorted([f"customers.{fmt.value}", f"orders.{fmt.value}"])
        payload = zf.read(f"customers.{fmt.value}")
    if fmt == ExportFormat.JSON:
        assert len(json.loads(payload)) == 20
    elif fmt == ExportFormat.JSONL:
        assert len(payload.decode().strip().splitlines()) == 20
    elif fmt == ExportFormat.PARQUET:
        assert pq.read_table(io.BytesIO(payload)).num_rows == 20
    elif fmt == ExportFormat.SQL:
        lines = payload.decode().strip().splitlines()
        assert len(lines) == 20 and lines[0].startswith('INSERT INTO "customers"')
    else:
        assert len(pd.read_csv(io.BytesIO(payload))) == 20


def test_sql_export_escapes_quotes():
    frame = pd.DataFrame({"name": ["O'Brien"], "n": [None]})
    assert export_frame("t", frame, ExportFormat.SQL).decode().strip() == """INSERT INTO "t" ("name", "n") VALUES ('O''Brien', NULL);"""


def test_pattern_generator():
    import numpy as np

    rng = np.random.default_rng(0)
    for pattern in [r"^[A-Z]{3}-\d{4}$", r"[a-f0-9]{8}", r"INV\d{2,5}", r"x?y+z*"]:
        for value in pattern_values(pattern, rng, 50):
            assert re.fullmatch(pattern, value), (pattern, value)
    with pytest.raises(UnsupportedPattern):
        compile_pattern("(a|b)")
