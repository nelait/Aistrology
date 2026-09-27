"""Multi-dataset analytics (LLM-008) and suggestion feedback / personalization (LLM-009)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..analytics import preferences
from ..analytics.multi import MAX_DATASETS, check_aliases, join_candidates, open_multi, run_multi, suggest_joined
from ..analytics.sql_sandbox import QueryResult, QueryTimeout, UnsafeQueryError
from ..analytics.suggestions import Category, ChartType, Suggestion
from ..auth.rbac import Permission
from ..auth.service import Principal
from ..datasets_io import load_table
from ..llm.router import LLMOutputError, LLMUnavailableError
from ..storage.datasets import DatasetRecord
from .datasets import compute_profile, get_record
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1", tags=["analytics"])
Reader = require(Permission.READ_DATA)
Creator = require(Permission.CREATE_ANALYTICS)
Admin = require(Permission.MANAGE_TENANT)


class MultiQuery(BaseModel):
    datasets: dict[str, str] = Field(min_length=1, max_length=MAX_DATASETS, description="{alias: dataset_id}")
    sql: str = Field(min_length=1, max_length=20_000)
    row_limit: int = Field(default=1000, ge=1, le=10_000)


class MultiSuggest(BaseModel):
    datasets: dict[str, str] = Field(min_length=2, max_length=MAX_DATASETS, description="{alias: dataset_id}")
    question: str | None = Field(default=None, max_length=2000)


class MultiSuggestions(BaseModel):
    suggestions: list[Suggestion]
    join_candidates: list[dict[str, Any]]


class SuggestionRef(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    chart_type: ChartType
    category: Category


class Feedback(BaseModel):
    accepted: bool
    suggestion: SuggestionRef


def _records(state: AppState, principal: Principal, datasets: dict[str, str]) -> dict[str, DatasetRecord]:
    try:
        check_aliases(datasets)
    except UnsafeQueryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {alias: get_record(state, principal, dataset_id) for alias, dataset_id in datasets.items()}  # 404 unless visible


@router.post("/analytics/query", response_model=QueryResult)
async def multi_query(body: MultiQuery, state: AppState = StateDep, principal: Principal = Reader) -> QueryResult:
    """Sandboxed SELECT over several datasets, each registered under its alias."""
    records = _records(state, principal, body.datasets)
    try:
        result = await asyncio.to_thread(run_multi, state.store, records, body.sql, body.row_limit)
    except UnsafeQueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except QueryTimeout as exc:
        raise HTTPException(status_code=408, detail=str(exc)) from exc
    state.audit.record(
        principal.tenant_id, principal.user_id, "analytics.multi_query", datasets=sorted(body.datasets.values()), rows=result.row_count
    )
    return result


@router.post("/analytics/suggestions", response_model=MultiSuggestions)
async def multi_suggestions(body: MultiSuggest, state: AppState = StateDep, principal: Principal = Creator) -> MultiSuggestions:
    """LLM-008: suggested analytics across 2+ datasets, with proposed joins validated in the multi-dataset sandbox."""
    records = _records(state, principal, body.datasets)
    for alias, record in records.items():
        if record.schema_ is None or not record.schema_.entities:
            raise HTTPException(status_code=409, detail=f"confirm the schema of {alias} before requesting suggestions")
    llm = state.router(principal.tenant_id, "analytics.suggest")
    level = state.llm_config(principal.tenant_id).data_minimization
    described = {}
    try:
        for alias, record in records.items():
            profile = await asyncio.to_thread(compute_profile, state, record)
            sample = await asyncio.to_thread(load_table, state.store, record, None, 20)
            described[alias] = (record.schema_, profile, sample)
        con = await asyncio.to_thread(open_multi, state.store, records)
    except (UnsafeQueryError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    stats = preferences.preference_stats(state, principal.tenant_id)
    try:
        candidates = await asyncio.to_thread(join_candidates, con, list(records))
        found = await suggest_joined(
            llm,
            con,
            described,
            level,
            candidates=candidates,
            actor=principal.user_id,
            question=body.question,
            preferences=preferences.summary(stats),
        )
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMOutputError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        con.close()
    return MultiSuggestions(suggestions=preferences.rerank(found, stats), join_candidates=candidates)


@router.post("/datasets/{dataset_id}/suggestions/feedback")
async def suggestion_feedback(
    dataset_id: str, body: Feedback, state: AppState = StateDep, principal: Principal = Creator
) -> dict[str, Any]:
    """LLM-009: record that a suggestion was accepted or rejected; returns the tenant's updated preference counts."""
    get_record(state, principal, dataset_id)
    ref = body.suggestion
    stats = await asyncio.to_thread(
        preferences.record_feedback,
        state,
        principal.tenant_id,
        principal.user_id,
        dataset_id,
        accepted=body.accepted,
        chart_type=ref.chart_type,
        category=ref.category,
        title=ref.title,
    )
    return {"preferences": stats, "summary": preferences.summary(stats)}


@router.get("/suggestions/preferences")
async def get_preferences(state: AppState = StateDep, principal: Principal = Creator) -> dict[str, Any]:
    stats = preferences.preference_stats(state, principal.tenant_id)
    return {"preferences": stats, "summary": preferences.summary(stats)}


@router.delete("/suggestions/preferences", status_code=204)
async def reset_preferences(state: AppState = StateDep, principal: Principal = Admin) -> None:
    await asyncio.to_thread(preferences.reset, state, principal.tenant_id)
    state.audit.record(principal.tenant_id, principal.user_id, "analytics.preferences.reset")
