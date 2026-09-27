# Analytics Platform

An AI-assisted, multi-tenant SaaS analytics platform. It takes raw data through profiling and cleaning to LLM-suggested analytics, trained models, and finally APIs and dashboards.

> This project is self-contained and unrelated to the Shastri astrology app in the rest of this repository. It lives here only until it gets its own repo.

| Doc | What's in it |
|-----|--------------|
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | Requirements v1.2; §15 lists what changed from v1.1 |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | What is built per module and phase, and what is not built yet, with reasons |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Topology, cloud abstraction, security layers, module map |
| [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | Every REST endpoint. The live OpenAPI document is at `/docs` |

## Layout

| Path | Contents |
|------|----------|
| [`backend/`](backend/) | Python 3.11 · FastAPI · DuckDB · pandas · scikit-learn/XGBoost/LightGBM/CatBoost · SQLAlchemy (SQLite for dev, Postgres with row-level security in production) |
| [`frontend/`](frontend/) | Next.js · TypeScript · Tailwind · ECharts |
| [`sdk/`](sdk/) | Python SDK plus `ap` CLI, TypeScript SDK, and Swift, Kotlin and Dart mobile SDKs |
| [`deploy/`](deploy/) | Dockerfile, Docker Compose, Helm chart (API, worker, retention CronJob) |
| [`infra/terraform/`](infra/terraform/) | GCP (GKE, Cloud SQL, GCS, Cloud KMS, Pub/Sub, Secret Manager) and AWS (EKS, RDS, S3, KMS, SQS, Secrets Manager) |

## Cloud provider is configuration

`AP_CLOUD_PROVIDER` selects the object store, secret manager, KMS and queue implementations:

| Value | Object storage | Secrets | Envelope keys | Queue |
|-------|---------------|---------|---------------|-------|
| `local` (default) | disk under `AP_DATA_DIR` | local file | local key | in-process |
| `gcp` | GCS (`AP_OBJECT_BUCKET`) | Secret Manager (`AP_GCP_PROJECT`) | Cloud KMS (`AP_GCP_KMS_KEY`) | Pub/Sub (`AP_GCP_PUBSUB_TOPIC` / `_SUBSCRIPTION`) |
| `aws` | S3 (`AP_OBJECT_BUCKET`) | Secrets Manager (`AP_AWS_REGION`) | KMS (`AP_AWS_KMS_KEY_ID`) | SQS (`AP_AWS_SQS_QUEUE_URL`) |

No module outside `backend/app/cloud/` imports a cloud SDK. The Terraform environments output exactly these variables, and the Helm chart ships `values-gcp.yaml` and `values-aws.yaml`.

## Run it locally

```bash
# Backend: http://localhost:8000/docs
cd backend
pip install -e ".[dev]"
AP_INLINE_WORKER=1 uvicorn app.main:app --reload

# Frontend: http://localhost:3000
cd frontend && npm install && npm run dev

# Or the whole stack with Postgres
docker compose -f deploy/docker/docker-compose.yml up --build
```

Sign up through the web app, or with `POST /v1/auth/signup {tenant_id, org_name, email, password}`. Out of the box, organizations use the offline demo LLM, which returns plausible canned suggestions. To use a real provider, add a key under **Settings → LLM** (Claude, OpenAI, Gemini or any OpenAI-compatible endpoint), or set `AP_PLATFORM_LLM_KIND` / `AP_PLATFORM_LLM_MODEL` for a platform default.

```bash
pip install -e sdk/python
export AP_URL=http://localhost:8000 AP_API_KEY=ap_live_...   # or: ap login
ap datasets upload customers.csv
ap experiments create churn ds_... churned --wait
ap models register churn run_...
ap endpoints deploy churn mdl_...
ap endpoints predict churn '[{"tenure": 3, "plan": "basic"}]'
```

## Checks

The same checks run in CI (`.github/workflows/analytics-platform-ci.yml`):

```bash
cd backend && ruff check . && ruff format --check . && pytest -q
cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build
cd sdk/python && pytest -q
cd sdk/typescript && npm test
cd sdk/kotlin && gradle build
cd sdk/swift && swift test
cd sdk/dart && dart analyze && dart test
```

## Design notes

- **Single-node analytics.** Decision D3 caps datasets at 1 GB, so DuckDB and pandas run in-process in the API or worker. There is no Spark.
- **One canonical schema.** Every input format parses into `app.schema.model.Schema`, and every module consumes that.
- **Jobs.** The database row is the source of truth. Job IDs travel over the configured queue. Workers also tick the cron scheduler; each schedule run is claimed with a conditional update.
- **Tenancy.** `tenant_id` is on every row, enforced by Postgres row-level security. Objects are encrypted per tenant with a KMS-wrapped data key, and deleting that key crypto-shreds the tenant.
- **Layered LLM safety.** PII is masked before data reaches a provider. Data is passed as delimited data, not instructions. Outputs are schema-validated, and generated SQL runs only as one SELECT in a locked-down DuckDB.
- **Determinism.** Generated data is seeded per column, so output is reproducible and previews equal the head of the full run.
