"""Multi-dataset analytics (LLM-008): several datasets in one sandbox, join discovery and joined suggestions.

Each dataset the caller can see is loaded into the locked-down sandbox under a caller-chosen alias
(``^[a-z_][a-z0-9_]{0,39}$``, never a SQL keyword-like reserved name), so queries read
``SELECT … FROM orders o JOIN customers c ON …``. Only single-table datasets can be aliased. User SQL is still a
single validated SELECT; the only platform-built SQL is the join-containment probe, whose identifiers come from
the dataset schemas and are always quoted.
"""

from __future__ import annotations

import json
import re
from typing import Any

import duckdb

from ..datasets_io import MultiTableError, main_table
from ..llm.base import LLMRequest, Message
from ..llm.config import DataMinimization
from ..llm.prompts import SUGGEST_JOINS_PROMPT
from ..llm.router import LLMRouter
from ..profiling.profile import DatasetProfile
from ..schema.model import Schema, column_renames
from ..storage.datasets import DatasetRecord, DatasetStore
from .saved import quote_ident
from .sql_sandbox import QueryResult, UnsafeQueryError, open_sandbox, run_query
from .suggestions import SuggestionSet, build_context, validate_suggestions

ALIAS_RE = re.compile(r"^[a-z_][a-z0-9_]{0,39}$")
RESERVED = {"select", "from", "where", "join", "on", "group", "order", "by", "limit", "table", "union", "as", "and", "or", "not"}
MAX_DATASETS = 5
KEY_HINT = re.compile(r"(^id$|_id$|id$|_key$|_code$|^key$|^code$)", re.IGNORECASE)


def check_aliases(datasets: dict[str, str]) -> None:
    if not datasets:
        raise UnsafeQueryError("pass at least one dataset")
    if len(datasets) > MAX_DATASETS:
        raise UnsafeQueryError(f"at most {MAX_DATASETS} datasets per query")
    for alias in datasets:
        if not ALIAS_RE.match(alias) or alias in RESERVED:
            raise UnsafeQueryError(f"invalid alias {alias!r}: use lowercase letters, digits and underscores (not a SQL keyword)")


def open_multi(store: DatasetStore, records: dict[str, DatasetRecord]) -> duckdb.DuckDBPyConnection:
    """One sandbox with each dataset's table registered under its alias (and canonical column names)."""
    tables, renames = {}, {}
    for alias, record in records.items():
        try:
            table = main_table(record)
        except MultiTableError as exc:
            raise UnsafeQueryError(f"dataset {record.id} ({alias}) has several tables; only single-table datasets can be joined") from exc
        tables[alias] = (store.table_path(record, table), table.format, table.encoding)
        if record.schema_ is not None and len(record.schema_.entities) == 1:
            renames[alias] = column_renames(record.schema_.entities[0])
    return open_sandbox(tables, renames=renames)


def run_multi(store: DatasetStore, records: dict[str, DatasetRecord], sql: str, row_limit: int) -> QueryResult:
    con = open_multi(store, records)
    try:
        return run_query(con, sql, row_limit=row_limit)
    finally:
        con.close()


def _columns(con: duckdb.DuckDBPyConnection, alias: str) -> dict[str, str]:
    return {r[0]: str(r[1]).upper() for r in con.execute(f"DESCRIBE {quote_ident(alias)}").fetchall()}


def _family(sql_type: str) -> str:
    t = sql_type.upper()
    if any(k in t for k in ("INT", "DECIMAL", "DOUBLE", "FLOAT", "REAL", "NUMERIC")):
        return "num"
    if "DATE" in t or "TIME" in t:
        return "date"
    if "BOOL" in t:
        return "bool"
    return "str"


def _singular(name: str) -> str:
    return name[:-3] + "y" if name.endswith("ies") else name[:-1] if name.endswith("s") else name


def join_candidates(con: duckdb.DuckDBPyConnection, aliases: list[str], limit: int = 10) -> list[dict[str, Any]]:
    """Likely join keys between each pair of tables: matching key-like names (``customer_id`` ↔ ``customers.id``
    or equal names), compatible types, and the share of distinct left values found on the right (containment)."""
    cols = {a: _columns(con, a) for a in aliases}
    out = []
    for i, left in enumerate(aliases):
        for right in aliases[i + 1 :]:
            for a, b in ((left, right), (right, left)):
                for ca, ta in cols[a].items():
                    for cb, tb in cols[b].items():
                        same = ca.lower() == cb.lower() and KEY_HINT.search(ca)
                        fk = cb.lower() == "id" and ca.lower() in (f"{_singular(b)}_id", f"{b}_id")
                        if not (same or fk) or _family(ta) != _family(tb):
                            continue
                        if same and a > b:
                            continue  # symmetric: report once
                        probe = (
                            f"SELECT count(DISTINCT l.{quote_ident(ca)}) AS n, "
                            f"count(DISTINCT CASE WHEN r.k IS NOT NULL THEN l.{quote_ident(ca)} END) AS hit "
                            f"FROM {quote_ident(a)} l LEFT JOIN (SELECT DISTINCT {quote_ident(cb)} AS k FROM {quote_ident(b)}) r "
                            f"ON l.{quote_ident(ca)} = r.k"
                        )
                        try:
                            n, hit = run_query(con, probe, row_limit=1, timeout_seconds=10).rows[0]
                        except (UnsafeQueryError, TimeoutError):
                            continue
                        containment = round(hit / n, 4) if n else 0.0
                        out.append({"left_table": a, "left_column": ca, "right_table": b, "right_column": cb, "containment": containment})
    out.sort(key=lambda c: c["containment"], reverse=True)
    return out[:limit]


async def suggest_joined(
    router: LLMRouter,
    con: duckdb.DuckDBPyConnection,
    datasets: dict[str, tuple[Schema, DatasetProfile | None, Any]],
    level: DataMinimization,
    *,
    candidates: list[dict[str, Any]],
    actor: str = "system",
    question: str | None = None,
    preferences: str | None = None,
):
    """Ask the model for analytics across the aliased tables, then validate each query in the multi-dataset sandbox."""
    described = []
    for alias, (schema, profile, sample) in datasets.items():
        context = build_context(schema, profile, sample, level)
        context["table"] = alias
        described.append(context)
    user = f"<datasets>\n{json.dumps({'datasets': described, 'join_candidates': candidates}, default=str)}\n</datasets>"
    if preferences:
        user += f"\n\n<preferences>\n{preferences[:1000]}\n</preferences>"
    if question:
        user += f"\n\nThe user asks: <question>{question.strip()[:2000]}</question>\nFocus the suggestions on this."
    request = LLMRequest(
        system=SUGGEST_JOINS_PROMPT.system,
        messages=[Message(role="user", content=user)],
        task="analytics.suggest_joins",
        template=SUGGEST_JOINS_PROMPT.ref,
        max_tokens=8000,
    )
    result = await router.complete_json(request, SuggestionSet, actor=actor)
    return validate_suggestions(con, result.suggestions)
