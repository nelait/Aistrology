# Implementation Status

What exists in this repository compared with [REQUIREMENTS.md](REQUIREMENTS.md) v1.2. Requirement IDs are cited in code docstrings, so `grep -rn "<ID>" backend frontend sdk` finds the implementation.

**Legend:**
- ✅ built and covered by automated tests
- 🟡 built with a documented limitation
- ⛔ not built

## By phase

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 (MVP, P0) | Golden path, multi-tenancy, BYOK plus platform LLM, SOC 2 technical controls | ✅, apart from the non-code items below |
| Phase 2 (Growth, P1) | Connectors, SQL DDL, schema history, clustering and forecasting, CatBoost/MLP/SVM, fallback chains, A/B, webhooks, OIDC SSO, SCIM, teams, themes, templates, notifications | ✅ with the exceptions listed |
| Phase 3 (Scale, P2) | Streaming ingestion, gRPC, GraphQL, canary, fairness, anomaly detection, projections, custom ONNX models, SSE/WebSocket inference, scheduling, comments | ✅ with the exceptions listed |

## By module

| Module | Highlights | Where |
|--------|------------|-------|
| 1. Schema and sample data | JSON Schema, XSD, SQL DDL, natural-language schemas (LLM), visual editor, schema history with diffs, deterministic prefix-stable generator (FKs, uniqueness, realistic values), CSV/JSON/JSONL/Parquet/SQL/XML export | `app/schema`, `app/generation`, `frontend/src/app/(app)/schemas` |
| 2. Ingestion and inference | Streaming single-shot and **resumable** uploads (1 GB cap enforced before and during transfer), format and encoding detection, archives, Excel, multi-table inference with FK detection, PII tagging, database and warehouse connectors (SSRF-guarded), streaming ingestion with compaction | `app/ingestion`, `app/storage`, `app/api/uploads.py`, `app/connectors`, `app/streams.py` |
| 3. Analysis and cleaning | Profiling, quality score, advanced profile, annotations, typed cleaning pipelines with undo/redo, preview, templates and versioned apply, fuzzy dedup | `app/profiling`, `app/cleaning` |
| 4. AI-assisted analytics | Sandboxed SQL, multi-dataset queries, LLM suggestions with categories, ranking and feedback learning, join suggestions, saved and parameterized analytics, provider-agnostic LLM layer (Claude, OpenAI, Gemini, OpenAI-compatible) with fallback, circuit breaker, cache, metering and prompt registry | `app/analytics`, `app/llm` |
| 5. Model training | AutoML with Optuna across linear, tree, boosting (XGBoost, LightGBM, CatBoost), SVM, MLP, clustering, forecasting and anomaly detection; SHAP; fairness; TF-IDF text features; projections; model registry; ONNX export and custom ONNX upload | `app/training` |
| 6. Dashboards | Chart, KPI, table, text, filter, image, prediction, alert and iframe widgets; cross-filtering; themes and dark mode; templates; sharing roles; public links; sandboxed custom widgets; HTML export and client-side PNG/PDF; comments with @mentions; scheduled delivery | `app/dashboards`, `frontend/src/components/dashboard` |
| 7. Integration and API gateway | REST endpoints with A/B splits, canary rollouts, batch, SSE and WebSocket streaming, drift, gRPC and GraphQL; API keys, OAuth client credentials, IP rules, quotas; outgoing and incoming webhooks; Python and TypeScript SDKs (SSE, WebSocket, OAuth client credentials, resumable uploads), `ap` CLI, Swift/Kotlin/Dart mobile SDKs | `app/serving`, `app/api`, `sdk/` |
| Cross-cutting | Configurable cloud (`AP_CLOUD_PROVIDER=local\|gcp\|aws`), per-tenant envelope encryption with crypto-shredding, Postgres RLS, argon2, MFA, OIDC SSO, SCIM, teams, projects, hash-chained audit log, consent, per-tenant retention policies with a daily sweep (SOC-PRV-002), Prometheus metrics, OpenTelemetry, cost attribution, cron scheduler | `app/cloud`, `app/auth`, `app/audit.py`, `app/observability.py`, `app/jobs` |
| Delivery | Docker and Compose, Helm chart (API, worker, HPA, PDB, NetworkPolicy), Terraform for GCP (GKE, Cloud SQL, GCS, KMS, Pub/Sub) and AWS (EKS, RDS, S3, KMS, SQS), GitHub Actions CI | `deploy/`, `infra/terraform`, `.github/workflows` |

## Not built, or built with limitations

| ID | Requirement | Status | Why / next step |
|----|-------------|--------|-----------------|
| SCH-005 | Avro / Protobuf *schema* import (P2) | ⛔ | Avro and Parquet *data* files are ingested, but `.avsc`/`.proto` are not parsed into the canonical schema. Next step: add parsers beside `app/schema/json_schema.py`. |
| AUTH-001 (SAML) | SAML 2.0 SSO (P1) | ⛔ | OIDC is built. SAML needs native `xmlsec`, which is not available in this build environment. |
| FE-007 | Custom Python transformations under SEC-009 (P1) | ⛔ | Needs a real isolation boundary (gVisor or Firecracker job sandbox), not an in-process one. |
| WCFG-004 | Drill-down paths (P1) | ⛔ | Cross-filtering is built; hierarchical drill-down is not. |
| VIZ-001b | Geo-map (P2) | ⛔ | Needs geocoding and a tile provider decision. |
| WDG-003a | Inline editing in data tables (P2) | ⛔ | |
| TRN-004a, TRN-007a, CFG-005 | RNN/LSTM, tabular transformers, N-BEATS, GPU and distributed training (P2) | ⛔ | Needs a GPU node pool and a separate training image. |
| CFG-004 | Maximum memory per training job | 🟡 | Time budgets and early stopping are enforced in-process. The memory limit comes from the worker pod's Kubernetes limits, not per job. |
| SDK-003 | Swift SDK | 🟡 | Built and tested on Linux (Swift 6.0.3, XCTest). `KeychainTokenStore` needs Apple's Security framework, so it is compiled only by the macOS CI job. |
| MT-005a, OQ-2 | Billing | ⛔ | Blocked on the open pricing decision. Usage metering and cost attribution exist as its input. |
| OQ-4, SEC-002 | Multi-region deployment | 🟡 | Tenants carry a `us`/`eu` region, and Terraform is per region. Routing between regional stacks is not built. |
| MT-002 | Horizontal scaling | 🟡 | API and workers are stateless and scale with the HPA. The LLM circuit breaker, stream tokens and webhook replay protection are per process; a shared Redis would make them global. |
| SEC-007, SOC-AUD-*, SOC-SEC-002/003/006/007/008/010, SOC-CON-005, SOC-PRV-001 | Penetration test, CPA audits, employee MFA, access reviews, incident response, training, background checks, risk register, vendor DPAs, privacy policy | ⛔ | Organizational, not code. Evidence sources (audit log, SCIM, change history via CI) exist. |
| SOC-AVL-001/004/005/006 | Synthetic uptime probes, DR drill, 80% capacity alerts, status page | 🟡 | Prometheus metrics, `/readyz` and HPA exist. Alert rules, probes and the status page belong to the monitoring stack of the deployment. |
| — | Frontend loads the Monaco editor from a CDN | 🟡 | Self-host it for strict CSP deployments. |
| — | Comments are orphaned when their dashboard is deleted | 🟡 | They are hidden, not deleted. Cleanup belongs in the retention job. |

## Verification

The CI workflow runs all of these on every push touching `analytics-platform/`:
- backend: `ruff check`, `ruff format --check`, `pytest`
- frontend: lint, typecheck, vitest, `next build`
- Python and TypeScript SDK tests, including an end-to-end test against the real backend
- Kotlin (`gradle build`), Swift (Linux and macOS) and Dart (`dart analyze`, `dart test`) SDK builds and tests
- Helm lint and `terraform validate`

MVP acceptance criteria 1 (a 30-minute journey with a real user) and 8 (500 RPS load test) need a deployed environment. They are not covered by the unit and integration suites.
