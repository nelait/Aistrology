"""Personalized suggestions from past feedback (LLM-009).

* Users accept or reject suggestions; each event updates per-tenant counts by chart type and category.
* Only those enum attributes are learned. No SQL, column names, titles or data values reach the prompt, so
  the summary contains no PII, and every read and write is scoped to one tenant (never shared across tenants).
* The learned preferences are (1) summarized in a few words in the suggestion prompt and (2) used to re-rank
  returned suggestions (Laplace-smoothed acceptance rate; valid suggestions always rank first).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select

from ..db.models import SuggestionFeedback, SuggestionPreference
from .suggestions import Category, ChartType, Suggestion

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

DIMENSIONS = ("chart_type", "category")
MIN_EVENTS = 3  # below this, there is nothing worth telling the model


def record_feedback(
    state: AppState,
    tenant_id: str,
    user_id: str,
    dataset_id: str,
    *,
    accepted: bool,
    chart_type: ChartType,
    category: Category,
    title: str | None = None,
) -> dict[str, Any]:
    values = {"chart_type": chart_type.value, "category": category.value}
    with state.db.session(tenant_id) as s:
        s.add(
            SuggestionFeedback(
                tenant_id=tenant_id,
                dataset_id=dataset_id,
                user_id=user_id,
                accepted=accepted,
                chart_type=values["chart_type"],
                category=values["category"],
                title=(title or None) and title[:200],
            )
        )
        for dimension, value in values.items():
            row = s.get(SuggestionPreference, (tenant_id, dimension, value))
            if row is None:
                row = SuggestionPreference(tenant_id=tenant_id, dimension=dimension, value=value, accepted=0, rejected=0)
                s.add(row)
            if accepted:
                row.accepted += 1
            else:
                row.rejected += 1
    return preference_stats(state, tenant_id)


def preference_stats(state: AppState, tenant_id: str) -> dict[str, dict[str, dict[str, int]]]:
    out: dict[str, dict[str, dict[str, int]]] = {d: {} for d in DIMENSIONS}
    with state.db.session(tenant_id) as s:
        for row in s.execute(select(SuggestionPreference).where(SuggestionPreference.tenant_id == tenant_id)).scalars():
            out.setdefault(row.dimension, {})[row.value] = {"accepted": row.accepted, "rejected": row.rejected}
    return out


def reset(state: AppState, tenant_id: str) -> None:
    with state.db.session(tenant_id) as s:
        s.execute(delete(SuggestionPreference).where(SuggestionPreference.tenant_id == tenant_id))
        s.execute(delete(SuggestionFeedback).where(SuggestionFeedback.tenant_id == tenant_id))


def _rate(counts: dict[str, int] | None) -> float:
    if not counts:
        return 0.5
    return (counts["accepted"] + 1) / (counts["accepted"] + counts["rejected"] + 2)


def summary(stats: dict[str, dict[str, dict[str, int]]]) -> str | None:
    """A short, non-PII sentence about what this organization tends to accept or reject."""
    total = sum(c["accepted"] + c["rejected"] for c in stats.get("chart_type", {}).values())
    if total < MIN_EVENTS:
        return None
    parts = []
    for dimension, noun in (("chart_type", "chart types"), ("category", "analysis categories")):
        ranked = sorted(stats.get(dimension, {}).items(), key=lambda kv: _rate(kv[1]), reverse=True)
        liked = [v for v, c in ranked if _rate(c) >= 0.6 and c["accepted"] >= 2][:3]
        disliked = [v for v, c in ranked if _rate(c) <= 0.34 and c["rejected"] >= 2][-3:]
        if liked:
            parts.append(f"Users here usually accept these {noun}: {', '.join(liked)}.")
        if disliked:
            parts.append(f"They usually reject: {', '.join(disliked)}.")
    if not parts:
        return None
    return " ".join(parts) + " Prefer what they accept, but still include anything clearly important."


def rerank(suggestions: list[Suggestion], stats: dict[str, dict[str, dict[str, int]]]) -> list[Suggestion]:
    """Stable sort: valid first, then by the learned acceptance rate of the chart type and category."""
    if not any(stats.get(d) for d in DIMENSIONS):
        return suggestions

    def score(s: Suggestion) -> float:
        return (_rate(stats["chart_type"].get(s.chart_type.value)) + _rate(stats["category"].get(s.category.value))) / 2

    return sorted(suggestions, key=lambda s: (not s.valid, -score(s)))
