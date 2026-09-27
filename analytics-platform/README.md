# Analytics Platform

An AI-assisted, multi-tenant SaaS analytics platform: raw data → profiled and cleaned data → LLM-suggested analytics → trained models → APIs and dashboards.

- **Requirements:** [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) (v1.2; its §15 lists what changed from v1.1)
- **Backend:** [`backend/`](backend/) (Python 3.11+, FastAPI, DuckDB, pandas)

> This project is self-contained and unrelated to the Shastri astrology app in the rest of this repository. It lives here only until it gets its own repo.

## What's built so far (Phase 1 foundations)

| Area | Requirements | Where |
|------|-------------|-------|
| Canonical schema model, validation, JSON Schema export | SCH-007/008/009/011 | `app/schema/model.py` |
| JSON Schema parser (`$ref`, nested objects, arrays → child entities, `x-*` extensions) | SCH-001 | `app/schema/json_schema.py` |
| XSD parser (documented subset, DTD/XXE rejected) | SCH-002, SEC-011 | `app/schema/xsd.py` |
| Natural-language → schema via the LLM layer, with one repair retry | SCH-003, NLP-001/004/006 | `app/schema/natural_language.py` |
| Seeded, prefix-stable sample-data generator (constraints, unique, FKs, self-references, realistic values, 1 GB estimate) | GEN-001…005/007/010, SCH-NFR-004 | `app/generation/` |
| Export to CSV / JSON / JSONL / Parquet / SQL INSERT | GEN-008 | `app/generation/export.py` |
| Streaming upload with the 1 GB limit, SHA-256, format and encoding detection, immutable raw files, tenant quota | ING-001…005/009/010, ING-NFR-004 | `app/storage/datasets.py`, `app/ingestion/formats.py` |
| Sample-based schema inference (types, date formats, roles, PK candidates, PII tags) | INF-001…004/009, ING-NFR-002 | `app/ingestion/inference.py` |
| Profiling (stats, histograms, IQR/Z outliers, duplicates, correlations, type mismatches, quality score) | ANA-001…007/009 | `app/profiling/profile.py` |
| Sandboxed read-only SQL (SELECT-only parse check, DuckDB lockdown, timeout, row cap) | USR-003, SEC-009, LLM-NFR-007 | `app/analytics/sql_sandbox.py` |
| LLM-suggested analytics; generated SQL is validated in the sandbox | LLM-001/002/005/006/007 | `app/analytics/suggestions.py` |
| Data minimization levels L0–L3 (PII masked by default) | LLM-NFR-004 | `app/analytics/suggestions.py`, `app/privacy.py` |
| Provider-agnostic LLM layer: OpenAI, Anthropic, Gemini, any OpenAI-compatible endpoint, plus a mock | LPA-001/002/003 | `app/llm/` |
| Fallback chain (errors and refusals), tenant-scoped cache, token and cost metering, BYOK secrets | LPA-004/005/007/010 | `app/llm/router.py`, `app/llm/config.py` |
| Tamper-evident (hash-chained) audit log, with PII redacted from LLM audit entries | AUTH-005, LLM-NFR-003 | `app/audit.py` |

**Not built yet:** real authentication (the tenant/user headers are a dev-only stub behind `AP_DEV_AUTH=1`), Postgres/object-storage persistence, async jobs, cleaning pipelines, model training, dashboards, the API gateway and SDKs, and the frontend.

## Run it

```bash
cd backend
pip install -e ".[dev]"
AP_DEV_AUTH=1 uvicorn app.main:app --reload
# open http://localhost:8000/docs

pytest          # 81 tests
ruff check . && ruff format --check .
```

Example calls:

```bash
H='-H X-Tenant-ID:demo-co -H content-type:application/json'

# Upload a CSV: schema is inferred, raw file stored immutably
curl -s -X POST localhost:8000/v1/datasets -H X-Tenant-ID:demo-co -F file=@sales.csv

# Profile, then query it with sandboxed SQL
curl -s localhost:8000/v1/datasets/$ID/profile -H X-Tenant-ID:demo-co
curl -s -X POST localhost:8000/v1/datasets/$ID/query $H -d '{"sql":"SELECT region, sum(amount) FROM data GROUP BY 1"}'

# Configure a real LLM (BYOK) with a fallback, then ask for suggestions
curl -s -X PUT localhost:8000/v1/tenant/secrets/anthropic $H -d '{"value":"sk-ant-..."}'
curl -s -X PUT localhost:8000/v1/tenant/llm-config $H \
  -d '{"chain":[{"kind":"anthropic","secret_name":"anthropic"},{"kind":"mock"}]}'
curl -s -X POST localhost:8000/v1/datasets/$ID/suggestions $H -d '{"question":"what drives revenue?"}'
```

Out of the box, every tenant uses the offline `mock` provider, which returns empty results. Configure a real provider as shown above to get actual suggestions and natural-language schemas.

## Design notes

- **Single-node analytics.** D3 (1 GB per dataset) means DuckDB and pandas handle everything in-process. There is no Spark.
- **One canonical schema.** Every input format parses into `app.schema.model.Schema`, and every module consumes that.
- **Determinism.** Each generated column has its own RNG, seeded from `(seed, entity, field)`, with separate streams for values, uniqueness fixes and nulls. Output is reproducible, adding a column leaves other columns unchanged, and previews equal the head of the full run.
- **Layered LLM safety.** Data goes into prompts as delimited data. Output is parsed and validated against a schema, SQL is statically restricted to one SELECT and run in a locked-down DuckDB, and PII is masked before it reaches the provider.
