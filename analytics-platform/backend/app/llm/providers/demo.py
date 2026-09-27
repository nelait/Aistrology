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
    if request.task == "schema.from_text":
        return _schema(prompt)
    if request.task == "model.explain":
        return (
            "[Offline demo explanation: configure an LLM provider in Admin → LLM for real summaries.] "
            "The model's predictions are driven mostly by the top features listed in the explanations tab; "
            "check the test-set metrics and the leakage warnings before relying on it."
        )
    return "{}" if request.json_output else "[offline demo response]"
