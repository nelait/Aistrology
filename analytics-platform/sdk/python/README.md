# Analytics Platform: Python SDK and `ap` CLI

```bash
pip install ./analytics-platform/sdk/python
```

## SDK

```python
from analytics_platform import Client

# With an API key (e.g. from a backend service)
ap = Client("https://api.example.com", api_key="ap_live_...")
ap.endpoints.predict("churn-prod", {"age": 42, "income": 61.5, "plan": "pro"})
# -> {"predictions": ["no"], "probabilities": [[0.83, 0.17]], "classes": ["no", "yes"], ...}

# As a user: log in, upload, clean, train, deploy
ap = Client("https://api.example.com")
ap.auth.login("ada@acme.example", "…", totp="123456")
ds = ap.datasets.upload("churn.csv")["dataset"]
pl = ap.pipelines.create(ds["id"], "clean", [{"op": "fill_missing", "columns": ["income"], "strategy": "median"}])
ap.pipelines.apply(pl["id"], wait=True)
exp = ap.experiments.create("churn", ds["id"], "churn", wait=True, automl={"n_trials": 30})
best = ap.experiments.best_run(exp["experiment"]["id"])
model = ap.models.register("churn", best["id"])
ap.models.set_stage(model["model_id"], model["version"], "production")
ap.endpoints.deploy("churn-prod", model["model_id"])
```

### Machine to machine: OAuth 2.0 client credentials

```python
creds = admin.tenant.create_oauth_client("scoring", role="analyst", scopes=["endpoints.predict"])  # the secret is shown once
ap = Client("https://api.example.com", client_id=creds["client_id"], client_secret=creds["client_secret"])
ap.endpoints.predict("churn-prod", rows)
```

The client posts the form-encoded grant to `/oauth/token` itself. It caches the token, renews it 30 s before it expires, and fetches a new one once if a call returns 401. RFC 6749 errors become `AuthenticationError` with `code` set to `invalid_client`, `invalid_scope`, and so on. `scope=` narrows the token to part of the client's permissions.

### Streaming predictions (Server-Sent Events)

```python
for event in ap.endpoints.predict_stream("churn-prod", rows, chunk_size=500):
    if event.event == "prediction":
        handle(event.data["offset"], event.data["predictions"])
# Forecasting endpoints: predict_stream("sales", horizon=30) yields one "forecast" event per step.
```

The response is read incrementally with httpx streaming.
- Before the stream starts, 429/503 are retried after `Retry-After`.
- An `error` event raises the matching typed error, for example `RateLimitError`.
- `endpoints.stream_token(name)` returns a single-use token for the WebSocket endpoint.

### Phase 2/3 features

```python
# Projects, teams, schedules
team = ap.teams.create("risk", members=[user_id]); ap.projects.add_team(project_id, team["id"])
s = ap.schedules.create("nightly", "0 3 * * *", "stream.compact", {"dataset_id": ds_id}, timezone="Europe/Berlin")
ap.schedules.run(s["id"], wait=True)                          # run now; also types(), list(), update(), pause(), resume(), delete()

# Streaming ingestion
stream = ap.streams.create("clicks")
ap.streams.send(stream["id"], [{"user": "u1", "n": 1}])         # not retried on 5xx (could duplicate records)
ap.streams.compact(stream["id"], wait=True); ap.streams.get(stream["id"])

# Connectors, dataset versions, annotations, advanced profiling
c = ap.connectors.create("lake", "s3", {"bucket": "raw"}, {"access_key_id": "…", "secret_access_key": "…"})
ap.connectors.import_data(c["id"], prefix="exports/2026/", wait=True)
ap.datasets.append(ds_id, "more.csv"); ap.datasets.replace(ds_id, "all.csv")
ap.datasets.set_annotations(ds_id, {"email": ["pii"]}); ap.datasets.advanced_profile(ds_id, near_duplicates={"enabled": False})

# Resumable uploads (automatic above 100 MB): resumes from the server's offset after errors
ap.datasets.upload_resumable("big.parquet", part_size=16 << 20, on_progress=lambda sent, total: print(sent, total))
ap.datasets.upload_resumable("big.parquet", upload_id="up_…")    # continue a session after a crash

# Multi-dataset analytics, suggestion feedback, schema history, comments
ap.analytics.query({"orders": o_id, "customers": c_id}, "SELECT c.region, sum(o.total) FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY 1")
ap.analytics.join_suggestions({"orders": o_id, "customers": c_id})
ap.datasets.suggestion_feedback(ds_id, accepted=True, suggestion={"chart_type": "bar", "category": "descriptive"})
ap.schemas.save("orders", schema, message="add discount"); ap.schemas.diff(schema_id)  # previous -> latest
ap.comments.create(dashboard_id, "@u_123 is this right?", widget_id="w1")

# ML: templates, fairness, projections, custom ONNX, ONNX export
ap.training_templates.apply(template_id, "churn-q3", ds_id, {"target": "churn"}, wait=True)
ap.experiments.fairness(run_id, ["gender", "age"]); ap.experiments.projection(run_id, method="pca")
ap.models.upload("model.onnx", {"problem_type": "binary", "classes": [0, 1], "features": [...]}, "custom-churn")
open("model.onnx", "wb").write(ap.experiments.onnx(run_id))

# Serving: forecasts, anomalies, canary rollouts, drift
ap.endpoints.forecast("sales", horizon=14)                       # {timestamps, predictions, lower, upper}
ap.endpoints.predict("fraud", row)["predictions"]               # [{"is_anomaly": True, "score": 0.93}]
ap.endpoints.canary_start("churn-prod", v2["model_version_id"], steps=[5, 25, 50, 100])
ap.endpoints.canary("churn-prod"); ap.endpoints.canary_promote("churn-prod")  # or canary_abort
ap.endpoints.drift("churn-prod", hours=24); ap.endpoints.drift_check("churn-prod", wait=True)

# Admin: retention (SOC-PRV-002)
ap.tenant.set_retention(inference_logs_days=14); ap.tenant.apply_retention()
```

The client handles these for you (SDK-008):
- **Authentication:** it sends the API key, or bearer tokens.
  - User tokens are refreshed automatically, and refresh tokens are single use. `on_tokens=` lets you persist the new pair.
  - OAuth client credentials are handled as described above.
- **Retries:** it retries with exponential backoff and jitter and respects `Retry-After`.
  - Reads and predictions are retried on 408/429/5xx.
  - Writes and uploads are retried only when the server did not process them (429/503, or a connection error before any response).
  - Resumable uploads resend a part from the server's offset.
- **Typed errors:** `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitError` (with `retry_after`), `ServerError`, and `JobFailedError` from `jobs.wait()`.

To verify a webhook in your receiver:

```python
from analytics_platform import verify_webhook_signature
ok = verify_webhook_signature(secret, request.body, request.headers["X-AP-Signature"])
```

## CLI

```bash
export AP_URL=https://api.example.com
ap login ada@acme.example            # stores rotating tokens in ~/.config/analytics-platform (0600)
ap datasets upload churn.csv         # files over 100 MB are uploaded resumably; --resumable / --resume UPLOAD_ID / --part-size
ap datasets query ds_… "SELECT plan, count(*) FROM data GROUP BY 1"
ap experiments create churn ds_… churn --config '{"automl": {"n_trials": 20}}' --wait
ap models register churn run_…
ap endpoints deploy churn-prod mdl_…
AP_API_KEY=ap_live_… ap endpoints predict churn-prod '[{"age": 42, "plan": "pro"}]'
ap endpoints batch churn-prod customers.csv --out predictions.csv

# Canary rollouts and drift
ap endpoints canary churn-prod start --model-version-id mv_… --steps 5,25,50,100 --max-error-rate 0.02
ap endpoints canary churn-prod status          # or promote / abort
ap endpoints drift churn-prod --hours 24       # PSI report; --check [--wait] queues an alerting drift check

# Schedules
ap schedules types
ap schedules create "nightly profile" "0 3 * * *" dataset.profile --params '{"dataset_id": "ds_…"}' --timezone Europe/Berlin
ap schedules list --job-type dataset.profile
ap schedules run sch_… --wait                  # also get / pause / resume / delete

# Streams
ap streams create clicks
ap streams send ds_… @events.jsonl             # JSON array, {"records": [...]}, JSON lines, @file or - (stdin)
ap streams status ds_…
ap streams compact ds_… --wait
```

Output is JSON, so it pipes straight into `jq`.

## Development

```bash
pip install -e "./analytics-platform/sdk/python[dev]"
cd analytics-platform/sdk/python && ruff check . && pytest -q
```

The test suite has mock-transport unit tests and an end-to-end journey against the real backend, run in process. The journey covers login, upload, cleaning, training, deploy, predict and batch, SSE streaming, fairness, a canary start and abort, streams, schedules, OAuth client credentials, resumable uploads and retention.
