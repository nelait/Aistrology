from __future__ import annotations

import pandas as pd
import pytest

from app.analytics.sql_sandbox import QueryTimeout, UnsafeQueryError, open_sandbox, run_query, validate_select
from app.ingestion.formats import DataFormat


@pytest.fixture
def con(tmp_path):
    path = tmp_path / "sales.csv"
    pd.DataFrame({"Region Name": ["east", "west", "east"], "amount": [10, 20, 30]}).to_csv(path, index=False)
    c = open_sandbox({"sales": (path, DataFormat.CSV, "utf-8")}, renames={"sales": {"Region Name": "region"}})
    yield c
    c.close()


def test_select_works_with_renamed_columns_and_data_alias(con):
    result = run_query(con, "SELECT region, sum(amount) AS total FROM data GROUP BY 1 ORDER BY 1;")
    assert result.columns == ["region", "total"]
    assert result.rows == [["east", 40], ["west", 20]]


def test_row_limit_truncates(con):
    result = run_query(con, "SELECT * FROM range(50)", row_limit=10)
    assert result.row_count == 10 and result.truncated


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE sales",
        "DELETE FROM sales",
        "SELECT 1; DROP TABLE sales",
        "COPY sales TO '/tmp/out.csv'",
        "ATTACH '/tmp/x.db'",
        "INSTALL httpfs",
        "SET enable_external_access = true",
        "PRAGMA database_list",
        "",
    ],
)
def test_non_select_statements_rejected(sql):
    with pytest.raises(UnsafeQueryError):
        validate_select(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_text('/etc/hostname')",
        "SELECT * FROM 'file:///etc/passwd'",
        "SELECT * FROM read_parquet('https://example.com/x.parquet')",
    ],
)
def test_file_and_network_access_blocked_at_runtime(con, sql):
    with pytest.raises(UnsafeQueryError):
        run_query(con, sql)


def test_comment_cannot_swallow_wrapper(con):
    result = run_query(con, "SELECT amount FROM sales -- trailing comment", row_limit=2)
    assert result.row_count == 2 and result.truncated


def test_timeout_interrupts_long_queries(con):
    with pytest.raises(QueryTimeout):
        run_query(con, "SELECT count(*) FROM range(100000000000) a, range(10) b", timeout_seconds=0.3)
