"""Module 1 endpoints: schema parsing and sample-data generation."""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..generation.export import ExportFormat, export_frame, export_zip, to_records
from ..generation.generator import GenerationError, GenerationOptions, GenerationTooLarge, check_size, generate, plan_counts, preview
from ..jobs.core import JobService
from ..llm.router import LLMOutputError, LLMUnavailableError
from ..projects import default_project_id
from ..schema.json_schema import parse_json_schema
from ..schema.model import Issue, Schema, SchemaValidationError, ensure_valid, to_json_schema, validate_schema
from ..schema.natural_language import parse_natural_language
from ..schema.xsd import parse_xsd
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1", tags=["schemas"])


class SchemaFormat(str, Enum):
    JSON_SCHEMA = "json_schema"
    XSD = "xsd"
    NATURAL_LANGUAGE = "natural_language"


class ParseRequest(BaseModel):
    format: SchemaFormat
    content: str = Field(min_length=1, max_length=2_000_000)
    # NLP-003: refine an existing schema with a follow-up instruction.
    current: Schema | None = None


class ParseResponse(BaseModel):
    schema_: Schema = Field(alias="schema")
    warnings: list[Issue]
    json_schema: dict[str, Any]

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class GenerateRequest(BaseModel):
    schema_: Schema = Field(alias="schema")
    options: GenerationOptions = Field(default_factory=GenerationOptions)
    format: ExportFormat = ExportFormat.CSV
    # Store the result as a dataset instead of downloading it.
    save_as: str | None = Field(default=None, max_length=200)

    model_config = {"populate_by_name": True}


def _issues_http(exc: SchemaValidationError) -> HTTPException:
    return HTTPException(status_code=422, detail={"message": "schema is invalid", "issues": [i.model_dump() for i in exc.issues]})


@router.post("/schemas/parse", response_model=ParseResponse)
async def parse_schema(
    body: ParseRequest, state: AppState = StateDep, principal: Principal = require(Permission.EDIT_PIPELINES)
) -> ParseResponse:
    try:
        if body.format == SchemaFormat.JSON_SCHEMA:
            schema, warnings = parse_json_schema(body.content)
        elif body.format == SchemaFormat.XSD:
            schema, warnings = parse_xsd(body.content)
        else:
            schema, warnings = await parse_natural_language(
                body.content, state.router(principal.tenant_id, "schema.from_text"), current=body.current, actor=principal.user_id
            )
    except SchemaValidationError as exc:
        raise _issues_http(exc) from exc
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMOutputError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "schema.parse", format=body.format.value, entities=len(schema.entities))
    return ParseResponse(schema_=schema, warnings=warnings, json_schema=to_json_schema(schema))


@router.post("/schemas/validate")
async def validate(schema: Schema, principal: Principal = require(Permission.READ_DATA)) -> dict[str, Any]:
    issues = validate_schema(schema)
    return {"valid": not any(i.severity == "error" for i in issues), "issues": [i.model_dump() for i in issues]}


@router.post("/generate/preview")
async def generate_preview(body: GenerateRequest, principal: Principal = require(Permission.WRITE_DATA)) -> dict[str, Any]:
    try:
        frames = preview(body.schema_, body.options)
    except SchemaValidationError as exc:
        raise _issues_http(exc) from exc
    except GenerationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "planned_rows": plan_counts(body.schema_, body.options),
        "entities": {name: to_records(frame) for name, frame in frames.items()},
    }


@router.post("/generate")
async def generate_data(body: GenerateRequest, state: AppState = StateDep, principal: Principal = require(Permission.WRITE_DATA)):
    try:
        planned = plan_counts(body.schema_, body.options)
        if sum(planned.values()) > state.settings.sync_generation_row_limit:
            # SCH-NFR-005: large runs go to the async job system and are saved as a dataset.
            ensure_valid(body.schema_)
            job = JobService(state).submit(
                principal.tenant_id,
                "data.generate",
                {"schema": body.schema_.model_dump(mode="json"), "options": body.options.model_dump(mode="json"), "name": body.save_as},
                principal.user_id,
            )
            return JSONResponse(job.model_dump(mode="json"), status_code=202)
        estimate = check_size(body.schema_, body.options)
        frames = generate(body.schema_, body.options)
    except SchemaValidationError as exc:
        raise _issues_http(exc) from exc
    except GenerationTooLarge as exc:
        raise HTTPException(status_code=413, detail={"message": str(exc), "max_count": exc.max_count}) from exc
    except GenerationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "data.generate",
        rows={k: len(v) for k, v in frames.items()},
        seed=body.options.seed,
        estimated_bytes=estimate,
    )
    if body.save_as:
        record = state.store.save_frames(
            principal.tenant_id,
            principal.user_id,
            body.save_as,
            frames,
            body.schema_,
            project_id=default_project_id(state, principal.tenant_id),
        )
        return record.model_dump(mode="json")
    if len(frames) == 1:
        name, frame = next(iter(frames.items()))
        media = "application/octet-stream" if body.format == ExportFormat.PARQUET else "text/plain"
        return Response(
            export_frame(name, frame, body.format),
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{name}.{body.format.value}"'},
        )
    return Response(
        export_zip(frames, body.format),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sample-data.zip"'},
    )
