"""Offline demo responses for the mock provider, so the product works end to end without an LLM key.

Output is schema-valid and derived from the request: suggestions use the dataset's real columns.
"""

from __future__ import annotations

import json
import re

from ..base import LLMRequest

_DATASET_RE = re.compile(r"<dataset>\s*(.*?)\s*</dataset>", re.DOTALL)


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _suggestions(prompt: str) -> str:
    match = _DATASET_RE.search(prompt)
    columns = json.loads(match.group(1)).get("columns", []) if match else []
    by_role = lambda *roles: [c for c in columns if c.get("role") in roles and not c.get("pii")]  # noqa: E731
    cats, nums, dates = by_role("categorical", "boolean"), by_role("continuous"), by_role("datetime")
    out = [
        {
            "title": "Row count",
            "category": "descriptive",
            "chart_type": "kpi",
            "aggregation": "count",
            "rationale": "[offline demo] How many records the dataset holds.",
            "sql": "SELECT count(*) AS rows FROM data",
        }
    ]
    if cats:
        c = cats[0]["name"]
        out.append(
            {
                "title": f"Records by {c}",
                "category": "descriptive",
                "chart_type": "bar",
                "x": c,
                "aggregation": "count",
                "group_by": [c],
                "rationale": f"[offline demo] Distribution of {c}.",
                "sql": f"SELECT {_q(c)}, count(*) AS n FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 50",
            }
        )
    if nums:
        n = nums[0]["name"]
        out.append(
            {
                "title": f"Distribution of {n}",
                "category": "descriptive",
                "chart_type": "histogram",
                "x": n,
                "rationale": f"[offline demo] Spread and outliers of {n}.",
                "sql": f"SELECT {_q(n)} FROM data WHERE {_q(n)} IS NOT NULL LIMIT 5000",
            }
        )
        if cats:
            c = cats[0]["name"]
            out.append(
                {
                    "title": f"Average {n} by {c}",
                    "category": "diagnostic",
                    "chart_type": "bar",
                    "x": c,
                    "y": n,
                    "aggregation": "avg",
                    "group_by": [c],
                    "rationale": f"[offline demo] Which {c} values differ most in {n}.",
                    "sql": f"SELECT {_q(c)}, avg({_q(n)}) AS avg_{re.sub(r'[^A-Za-z0-9_]', '_', n)} FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 50",
                }
            )
    if dates:
        d = dates[0]["name"]
        out.append(
            {
                "title": f"Records per month ({d})",
                "category": "descriptive",
                "chart_type": "line",
                "x": d,
                "aggregation": "count",
                "rationale": f"[offline demo] Trend over time by {d}.",
                "sql": f"SELECT date_trunc('month', CAST({_q(d)} AS TIMESTAMP)) AS month, count(*) AS n FROM data GROUP BY 1 ORDER BY 1",
            }
        )
    return json.dumps({"suggestions": out})


_DATASETS_RE = re.compile(r"<datasets>\s*(.*?)\s*</datasets>", re.DOTALL)
_KEY_RE = re.compile(r"(^id$|_id$|_key$|_code$)", re.IGNORECASE)


def _guess_joins(tables: list[dict]) -> list[dict]:
    """Name-based fallback when the platform sent no join candidates: ``x_id`` ↔ ``xs.id`` or equal key names."""
    out = []
    for a in tables:
        for b in tables:
            if a is b:
                continue
            names_b = {c["name"].lower(): c["name"] for c in b.get("columns", [])}
            table_b = b["table"].lower()
            for col in a.get("columns", []):
                name = col["name"].lower()
                if "id" in names_b and name in (f"{table_b}_id", f"{table_b.rstrip('s')}_id"):
                    out.append(
                        {"left_table": a["table"], "left_column": col["name"], "right_table": b["table"], "right_column": names_b["id"]}
                    )
                elif name in names_b and _KEY_RE.search(name) and name != "id" and a["table"] < b["table"]:
                    out.append(
                        {"left_table": a["table"], "left_column": col["name"], "right_table": b["table"], "right_column": names_b[name]}
                    )
    return out


def _joined_suggestions(prompt: str) -> str:
    """LLM-008 demo: join on the best candidate key and combine a measure from one side with a dimension from the other."""
    match = _DATASETS_RE.search(prompt)
    payload = json.loads(match.group(1)) if match else {}
    tables = payload.get("datasets", [])
    joins = [j for j in payload.get("join_candidates", []) if j.get("containment", 1) >= 0.5] or _guess_joins(tables)
    by_table = {t["table"]: t.get("columns", []) for t in tables}
    out = []
    if joins:
        j = joins[0]
        lt, lc, rt, rc = j["left_table"], j["left_column"], j["right_table"], j["right_column"]
        on = f"l.{_q(lc)} = r.{_q(rc)}"
        out.append(
            {
                "title": f"{lt} matched to {rt}",
                "category": "descriptive",
                "chart_type": "kpi",
                "aggregation": "count",
                "rationale": f"[offline demo] How many {lt} rows join to {rt} on {lc} = {rc}.",
                "sql": f"SELECT count(*) AS matched_rows FROM {_q(lt)} l JOIN {_q(rt)} r ON {on}",
            }
        )

        def usable(cols: list[dict], roles: tuple[str, ...], skip: str) -> list[str]:
            return [c["name"] for c in cols if c.get("role") in roles and not c.get("pii") and c["name"] != skip]

        dims = usable(by_table.get(rt, []), ("categorical", "boolean"), rc)
        measures = usable(by_table.get(lt, []), ("continuous",), lc)
        if dims:
            d = dims[0]
            if measures:
                m = measures[0]
                title, chart_y, agg, measure = f"Total {m} by {d}", m, "sum", f"sum(l.{_q(m)}) AS total"
            else:
                title, chart_y, agg, measure = f"{lt} rows by {d}", None, "count", "count(*) AS n"
            out.append(
                {
                    "title": title,
                    "category": "diagnostic",
                    "chart_type": "bar",
                    "x": d,
                    "y": chart_y,
                    "aggregation": agg,
                    "group_by": [d],
                    "rationale": f"[offline demo] Combines {lt} with {rt}.{d} through the {lc} = {rc} join.",
                    "sql": f"SELECT r.{_q(d)}, {measure} FROM {_q(lt)} l JOIN {_q(rt)} r ON {on} GROUP BY 1 ORDER BY 2 DESC LIMIT 50",
                }
            )
    elif tables:
        out.append(
            {
                "title": "Rows per table",
                "category": "descriptive",
                "chart_type": "bar",
                "x": "table_name",
                "aggregation": "count",
                "rationale": "[offline demo] No joinable keys were found; compare table sizes instead.",
                "sql": " UNION ALL ".join(f"SELECT '{t['table']}' AS table_name, count(*) AS n FROM {_q(t['table'])}" for t in tables),
            }
        )
    return json.dumps({"suggestions": out})


def _schema(prompt: str) -> str:
    text = prompt.lower()
    fields = [{"name": "id", "type": "integer", "primary_key": True}]
    for word, field in [
        ("name", {"name": "name", "type": "string", "semantic": "full_name", "nullable": False}),
        ("email", {"name": "email", "type": "string", "semantic": "email", "unique": True}),
        ("birth", {"name": "date_of_birth", "type": "date"}),
        ("price", {"name": "price", "type": "number", "minimum": 0}),
        ("quantity", {"name": "quantity", "type": "integer", "minimum": 1}),
        ("date", {"name": "created_at", "type": "datetime"}),
    ]:
        if word in text and all(f["name"] != field["name"] for f in fields):
            fields.append(field)
    if len(fields) == 1:
        fields.append({"name": "name", "type": "string"})
    return json.dumps({"name": "demo", "entities": [{"name": "records", "description": "[offline demo schema]", "fields": fields}]})


def demo_response(request: LLMRequest) -> str:
    prompt = "\n".join(m.content for m in request.messages)
    if request.task == "analytics.suggest":
        return _suggestions(prompt)
    if request.task == "analytics.suggest_joins":
        return _joined_suggestions(prompt)
    if request.task == "schema.from_text":
        return _schema(prompt)
    if request.task == "model.explain":
        return (
            "[Offline demo explanation: configure an LLM provider in Admin → LLM for real summaries.] "
            "The model's predictions are driven mostly by the top features listed in the explanations tab; "
            "check the test-set metrics and the leakage warnings before relying on it."
        )
    return "{}" if request.json_output else "[offline demo response]"
