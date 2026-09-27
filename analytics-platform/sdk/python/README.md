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

The client handles these for you (SDK-008):
- **Authentication:** it sends the API key, or bearer tokens with automatic single-use refresh-token rotation (`on_tokens=` lets you persist the new pair).
- **Retries:** it retries with exponential backoff and jitter and respects `Retry-After`.
  - Reads and predictions are retried on 408/429/5xx.
  - Writes are retried only when the server did not process them (429/503, or a connection error before any response).
- **Typed errors:** `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `ValidationError`, `RateLimitError` (with `retry_after`), `ServerError`, and `JobFailedError` from `jobs.wait()`.

To verify a webhook in your receiver:

```python
from analytics_platform import verify_webhook_signature
ok = verify_webhook_signature(secret, request.body, request.headers["X-AP-Signature"])
```

## CLI

```bash
export AP_URL=https://api.example.com
ap login ada@acme.example            # stores rotating tokens in ~/.config/analytics-platform (0600)
ap datasets upload churn.csv
ap datasets query ds_… "SELECT plan, count(*) FROM data GROUP BY 1"
ap experiments create churn ds_… churn --config '{"automl": {"n_trials": 20}}' --wait
ap models register churn run_…
ap endpoints deploy churn-prod mdl_…
AP_API_KEY=ap_live_… ap endpoints predict churn-prod '[{"age": 42, "plan": "pro"}]'
ap endpoints batch churn-prod customers.csv --out predictions.csv
```

Output is JSON, so it pipes straight into `jq`.
