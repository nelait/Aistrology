"""ANA-004a Isolation Forest, ANA-005a/CLN-003a near duplicates, ANA-008 missing patterns, ANA-010 annotations."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.api.deps import build_state
from app.cleaning.fuzzy import find_near_duplicates, normalize_text
from app.cleaning.steps import Step, run_steps
from app.main import create_app
from app.profiling.advanced import IsolationForestOptions, isolation_forest, missing_patterns, near_duplicates

ACME = {"X-Tenant-ID": "acme", "X-User-ID": "ana"}


def _numeric_frame(n: int = 500) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    df = pd.DataFrame({"x": rng.normal(0, 1, n), "y": rng.normal(10, 2, n), "label": ["a"] * n, "flag": [True] * n})
    df.loc[[5, 17], ["x", "y"]] = [[40, -30], [-35, 60]]
    return df


def test_isolation_forest_flags_planted_outliers():
    df = _numeric_frame()
    report = isolation_forest(df, IsolationForestOptions(contamination=0.01))
    assert report.columns == ["x", "y"]  # numeric only; booleans and strings are skipped
    assert report.outlier_count == 5 and report.sampled_rows == 500
    assert {e.row for e in report.examples[:2]} == {5, 17}
    # Sampling caps the fitted rows and keeps positional row numbers.
    big = pd.concat([df] * 3, ignore_index=True)
    sampled = isolation_forest(big, IsolationForestOptions(max_rows=600, contamination=0.01))
    assert sampled.sampled_rows == 600 and all(0 <= e.row < len(big) for e in sampled.examples)
    assert isolation_forest(pd.DataFrame({"s": ["a"] * 20})).message
    with pytest.raises(ValidationError):
        IsolationForestOptions(contamination=0.9)
    with pytest.raises(ValueError, match="numeric"):
        isolation_forest(df, IsolationForestOptions(columns=["label"]))


PEOPLE = pd.DataFrame(
    {
        "id": range(1, 9),
        "name": ["John Smith", "john  smith", "Jon Smith", "Mary Jones", "Maria Jones", "Peter Pan", "Wendy Darling", "PETER PAN."],
        "city": ["Boston", "boston", "Boston", "Denver", "Denver", "London", "London", "London"],
    }
)


def test_near_duplicate_detection_and_normalization():
    assert normalize_text("  Crème-Brûlée!! ") == "creme brulee"
    matches = find_near_duplicates(PEOPLE, threshold=0.85)
    assert matches.columns == ["name", "city"]  # the unique id column is excluded by default
    clusters = sorted(sorted(c) for c in matches.clusters.values())
    assert [0, 1, 2] in clusters and [5, 7] in clusters and [3, 4] in clusters
    assert matches.duplicate_rows == 4
    report = near_duplicates(PEOPLE)
    assert report.duplicate_rows >= 3 and report.examples and report.method in ("rapidfuzz", "difflib")
    strict = find_near_duplicates(PEOPLE, ["name"], threshold=1.0)
    assert sorted(sorted(c) for c in strict.clusters.values()) == [[0, 1], [5, 7]]


def test_near_duplicates_scale_linearly():
    rng = np.random.default_rng(1)
    names = [f"customer {i} {rng.integers(0, 10**6)}" for i in range(20_000)]
    df = pd.DataFrame({"name": names + [n.upper() + "." for n in names[:100]]})
    matches = find_near_duplicates(df, ["name"], threshold=0.95, window=5)
    assert matches.duplicate_rows == 100


def test_fuzzy_deduplicate_step():
    steps = TypeAdapter(list[Step]).validate_python([{"op": "fuzzy_deduplicate", "columns": ["name", "city"], "threshold": 0.85}])
    out, stats = run_steps(PEOPLE, steps)
    assert out["id"].tolist() == [1, 4, 6, 7] and stats[0].rows_after == 4
    last, _ = run_steps(PEOPLE, TypeAdapter(list[Step]).validate_python([{"op": "fuzzy_deduplicate", "threshold": 0.85, "keep": "last"}]))
    assert 8 in last["id"].tolist() and 1 not in last["id"].tolist()
    with pytest.raises(ValidationError):
        TypeAdapter(list[Step]).validate_python([{"op": "fuzzy_deduplicate", "threshold": 0.2}])


def test_missing_patterns_heuristics():
    rng = np.random.default_rng(2)
    n = 1000
    age = rng.integers(18, 80, n).astype(float)
    income = rng.normal(50_000, 10_000, n)
    # income is missing mostly for young people (MAR); score is missing at random (MCAR).
    income[(age < 30) & (rng.random(n) < 0.8)] = np.nan
    score = rng.normal(0, 1, n)
    score[rng.random(n) < 0.1] = np.nan
    region = rng.choice(["n", "s"], n).astype(object)
    region[np.isnan(score) & (rng.random(n) < 0.5)] = None  # co-missing with score
    df = pd.DataFrame({"age": age, "income": income, "score": score, "region": region})
    report = missing_patterns(df)
    assert report.heuristic and "MNAR" in report.method
    labels = {m.column: m for m in report.mechanisms}
    assert labels["income"].label == "MAR (heuristic)" and "age" in labels["income"].associated_with
    assert labels["score"].label in ("MCAR (heuristic)", "MAR (heuristic)")
    assert report.co_missingness["score"]["region"] > 0.3 and report.indicator_correlation["score"]["region"] > 0.3
    assert report.patterns[0].missing_columns == [] and report.patterns[0].count > 0
    assert set(report.missing_fraction) == {"income", "score", "region"}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None)))


def test_advanced_profile_and_annotations_api(client):
    df = _numeric_frame(200)
    df["x"] = df["x"].where(df.index % 10 != 0)
    ds = client.post("/v1/datasets", files={"file": ("m.csv", df.to_csv(index=False).encode())}, headers=ACME).json()["dataset"]
    r = client.post(
        f"/v1/datasets/{ds['id']}/profile/advanced",
        json={"isolation_forest": {"contamination": 0.02}, "near_duplicates": {"enabled": False}},
        headers=ACME,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["isolation_forest"]["outlier_count"] == 4 and body["near_duplicates"] is None
    assert body["missing_patterns"]["missing_fraction"] == {"x": 0.1}
    default = client.post(f"/v1/datasets/{ds['id']}/profile/advanced", headers=ACME).json()
    assert default["near_duplicates"]["rows_scanned"] == 200
    bad = client.post(f"/v1/datasets/{ds['id']}/profile/advanced", json={"isolation_forest": {"columns": ["label"]}}, headers=ACME)
    assert bad.status_code == 422

    # ANA-010 annotations.
    r = client.put(
        f"/v1/datasets/{ds['id']}/annotations", json={"columns": {"label": ["target"], "y": ["sensitive", "derived"]}}, headers=ACME
    )
    assert r.status_code == 200, r.text
    assert r.json()["annotations"] == {"m": {"y": ["sensitive", "derived"], "label": ["target"]}}
    fields = {f["name"]: f for f in client.get(f"/v1/datasets/{ds['id']}", headers=ACME).json()["schema"]["entities"][0]["fields"]}
    assert fields["y"]["pii"] is True and fields["label"]["annotations"] == ["target"]
    r = client.put(f"/v1/datasets/{ds['id']}/annotations", json={"columns": {"label": ["id"]}, "replace": False}, headers=ACME)
    assert r.json()["annotations"]["m"]["label"] == ["target", "id"]
    assert client.get(f"/v1/datasets/{ds['id']}/annotations", headers=ACME).json()["annotations"]["m"]["label"] == ["target", "id"]
    assert client.put(f"/v1/datasets/{ds['id']}/annotations", json={"columns": {"nope": ["pii"]}}, headers=ACME).status_code == 422
    assert client.put(f"/v1/datasets/{ds['id']}/annotations", json={"columns": {"x": ["bogus"]}}, headers=ACME).status_code == 422
    assert client.get(f"/v1/datasets/{ds['id']}/annotations", headers={"X-Tenant-ID": "globex"}).status_code == 404
