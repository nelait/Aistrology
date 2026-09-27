# API Contract (v1)

The shared contract between the backend and the frontend/SDKs. The FastAPI app also serves the full OpenAPI document at `/openapi.json`.

## Authentication
- `POST /v1/auth/signup` `{tenant_id, org_name, email, password, name?, region: "us"|"eu"}` returns `{tenant_id, user_id}`.
- `POST /v1/auth/login` `{email, password, totp?}` returns `{access_token, refresh_token, expires_in, token_type}`.
  - On a 401, `detail.code` is one of `invalid_credentials`, `locked`, `mfa_required`, `mfa_invalid`, `mfa_enrollment_required` or `disabled`.
- `POST /v1/auth/refresh` `{refresh_token}` returns a new token pair. Refresh tokens rotate: each one can be used once.
- `POST /v1/auth/logout` `{refresh_token}`.
- `GET /v1/auth/me` returns `{tenant_id, id, role, method, email?, name?, mfa_enabled?}`.
- `POST /v1/auth/mfa/setup` returns `{otpauth_uri}`. `POST /v1/auth/mfa/activate` `{code}`.
- Every other call sends `Authorization: Bearer <access_token>`, or an API key as `X-API-Key: ap_live_…` / `Authorization: Bearer ap_live_…`.
- Roles: `admin`, `data_engineer`, `data_scientist`, `analyst`, `viewer`.
- SSO (OIDC):
  - `GET /v1/auth/oidc/providers` returns `{providers}`.
  - `GET /v1/auth/oidc/{provider}/authorize?redirect_uri=` returns `{authorization_url, state}`.
  - `POST /v1/auth/oidc/{provider}/callback` `{code, state}` returns a token pair.
  - Tenant admins claim email domains for just-in-time sign-up with `GET`/`PUT /v1/tenant/sso` `{domains, default_role}`.

## Projects (`/v1/projects`)
- `GET` lists the projects visible to the caller. `POST` `{name, open, members[]}` (admin only).
- `POST /{id}/members` `{user_id}`. `DELETE /{id}/members/{user_id}`.
- Datasets belong to a project: uploads take `?project_id=`, defaulting to the open "Default" project, and `GET /v1/datasets?project_id=` filters by project. Users who aren't admins see only open projects and the projects they belong to.

## Quotas
- Heavy jobs beyond `max_concurrent_jobs` get a 429 with `detail = {code: "quota_exceeded", quota, limit, message}`.
- The platform-provided LLM (`chain: [{kind: "platform"}]`, the default) is capped at `llm_tokens_per_month`.
- `task_models` in the LLM config picks a model per task (`analytics.suggest`, `schema.from_text`, `model.explain`).

## Tenant admin (`/v1/tenant`)
- `GET` / `PATCH` / `DELETE ?confirm=<tenant>` on `/v1/tenant` itself.
- `/users`: GET, POST `{email, role, password, name?}`; `/users/{id}`: PATCH `{role?, disabled?}`.
- `/api-keys`: GET, POST `{name, role, scopes[], rate_limit_per_minute, expires_in_days?, allowed_ips[]}` returns `{key, …}` with the key shown once. `/api-keys/{id}/rotate`: POST. `/api-keys/{id}`: DELETE.
- `/llm-config`: GET/PUT `{chain: [{kind: openai|openai_compatible|anthropic|gemini|mock, model?, base_url?, secret_name?}], data_minimization: L0|L1|L2|L3, cache_enabled}`.
- `/secrets/{name}`: PUT `{value}` or DELETE. `/secrets`: GET returns `{names}`.
- `/llm-usage`, `/usage`, `/audit?action=`, `/audit/verify`: GET.
- `/exports`: POST returns a job. `/exports/{job_id}`: GET returns the zip.

## Schemas and sample data
- `POST /v1/schemas/parse` `{format: json_schema|xsd|natural_language, content, current?}` returns `{schema, warnings, json_schema}`.
- `POST /v1/schemas/validate` with a schema body.
- `POST /v1/generate/preview` `{schema, options: {count, counts, seed, children_per_parent, null_rate}}` returns `{planned_rows, entities: {name: rows[]}}`.
- `POST /v1/generate` `{schema, options, format: csv|json|jsonl|parquet|sql, save_as?}` returns one of:
  - a file download,
  - a DatasetRecord (when `save_as` is given),
  - a 202 job (when the run is too large for a synchronous request).

### Canonical schema
`{name, entities: [{name, fields: [Field]}]}`, where a Field is:

```
{name, type: string|integer|number|boolean|date|datetime|array, items_type?, nullable,
 primary_key, unique, enum?, minimum?, maximum?, min_length?, max_length?, pattern?,
 semantic?, role?, pii, references?: {entity, field}, description?, source_name?}
```

## Datasets (`/v1/datasets`)
- `POST` (multipart `file`) or `PUT /upload?filename=` (raw body) returns `{dataset: DatasetRecord, inference: {schema, columns[], sampled_rows, warnings[]}}`.
- `GET` (list) and `GET /{id}?version=`. `GET /{id}/versions`. `DELETE /{id}`.
- `PUT /{id}/schema` with a Schema body, to confirm the inferred schema.
- `GET /{id}/profile?version=` returns a DatasetProfile:
  - `row_count`, `column_count`, `duplicate_row_count`, `correlations`, `warnings`.
  - `columns[]`: name, type, role, count, null_count, null_fraction, distinct_count, min, max, mean, median, std, percentiles, histogram `{edges, counts}`, outliers `{iqr_count, iqr_bounds, zscore_count}`, top_values `[[v, n]]`, type_mismatch.
  - `quality`: `{score, completeness, uniqueness, validity, consistency, formula}`.
- `POST /{id}/query?version=` `{sql, row_limit}` returns `{columns, rows, row_count, truncated}`. The main table is called `data`.
- `POST /{id}/suggestions` `{question?}` returns a list of `{title, category, chart_type, x, y, aggregation, group_by, rationale, sql, valid, validation_error, preview}`.

DatasetRecord: `{id, tenant_id, name, version, latest_version, parent_version, pipeline_id, source, created_at, created_by, tables: [{name, file, format, size_bytes, sha256, row_count?}], schema, size_bytes}`.

## Cleaning pipelines (`/v1/pipelines`)
- `POST` `{dataset_id, name, steps[]}`. `GET ?dataset_id=`. `GET /templates`. `POST /from-template` `{template_id, dataset_id}`.
- `GET /{id}`. `POST /{id}/steps` `{step}`. `POST /{id}/undo`, `POST /{id}/redo`.
- `POST /{id}/preview` `{step?, rows}` returns `{sample_rows, rows, columns, step_stats[], column_deltas[]}`.
- `POST /{id}/template` `{name}`. `POST /{id}/apply` returns a job; its result is `{dataset_id, version, parent_version, rows, step_stats}`.
- Every step has an `op`:

| op | Fields |
|----|--------|
| `drop_missing` | `axis`, `columns`, `how`, `max_null_fraction` |
| `fill_missing` | `columns`, `strategy`: mean \| median \| mode \| constant \| ffill \| bfill \| interpolate, `value` |
| `handle_outliers` | `columns`, `method`: iqr \| zscore, `threshold`, `action`: remove \| cap \| flag |
| `deduplicate` | `columns`, `keep` |
| `cast` | `column`, `to`, `format`, `on_error` |
| `normalize_strings` | `columns`, `trim`, `case`, `find`, `replace`, `collapse_whitespace` |
| `normalize_dates` | `column`, `formats[]`, `output`, `dayfirst` |
| `rename` | `mapping` |
| `drop_columns` | `columns` |
| `reorder` | `columns` |
| `split` | `column`, `separator`, `into[]`, `drop_original` |
| `merge` | `columns`, `into`, `separator`, `drop_original` |
| `derive` | `name`, `expression` (SQL expression) |
| `filter` | `condition` (SQL condition) |
| `mask_pii` | `columns`, `strategy`: partial \| hash \| redact |

## Jobs and notifications
- `GET /v1/jobs?status=`, `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel`.
  - Job: `{id, type, status: queued|running|succeeded|failed|cancelled, progress 0..1, message, params, result, error, attempts, created_at, started_at, finished_at}`.
- `GET /v1/notifications?unread_only=`, `POST /v1/notifications/{id}/read`.

## Model Training Studio
- `GET /v1/algorithms` returns `[{id, name, family, problem_types[], hyperparameters: [{name, type, default, min?, max?, choices?, log?, help}]}]`.
- `POST /v1/experiments/detect` `{dataset_id, target}` returns `{problem_type, reason, classes?}`.
- `POST /v1/experiments` creates an experiment and a training job, and returns `{experiment, job}`. Body:

```
{name, dataset_id, dataset_version?, target, features?: string[],
 problem_type?: binary|multiclass|regression,
 split: {method: random|stratified|time, test_size: 0.2, validation_size: 0.0, time_column?},
 cv: {method: kfold|stratified_kfold|timeseries, folds: 5},
 algorithms?: string[],
 automl: {enabled: true, strategy: random|grid|tpe, n_trials: 20, timeout_seconds: 300},
 hyperparameters?: {algorithm_id: {param: value}},
 preprocessing: {encoding: onehot|ordinal|target, scaling: standard|minmax|robust|log|none,
                 impute: median|mean|most_frequent,
                 feature_selection?: {method: mutual_info|correlation|rfe|l1, k}},
 class_imbalance: none|class_weight|smote|undersample|oversample,
 max_training_seconds: 600, seed: 42}
```

- `GET /v1/experiments`. `GET /v1/experiments/{id}` returns `{experiment, runs[]}`.
- `GET /v1/runs/{id}` returns a run:
  - `{id, experiment_id, status, algorithm, params, metrics, duration_seconds, artifacts}`.
  - `artifacts` holds `leaderboard[]`, `confusion_matrix`, `roc_curve {fpr, tpr}`, `pr_curve {precision, recall}`, `calibration {prob_pred, prob_true}`, `residuals {predicted, residual}`, `learning_curve {train_sizes, train_scores, val_scores}`, `feature_importance [{feature, importance}]`, `permutation_importance [...]`, `shap_summary [{feature, mean_abs_shap}]`, `pdp {feature: {grid, average}}`, `explanation_text?`.
- `GET /v1/experiments/compare?run_ids=a,b` returns `{runs: [...], metrics: [names]}`.
- `POST /v1/runs/{id}/explain` `{instances: [{feature: value}]}` returns `{predictions, shap: [{feature: value}], base_value}` (what-if analysis).

## Model registry
- `POST /v1/models` `{name, run_id, description?}` registers a new version.
- `GET /v1/models`. `GET /v1/models/{id}` returns `{model, versions: [{version, stage, run_id, metrics, signature, created_at}]}`.
- `POST /v1/models/{id}/versions/{version}/stage` `{stage: none|staging|production|archived}`.

## Serving and API gateway
- `POST /v1/endpoints` `{name, model_id, version?, routes?: [{model_version_id, weight}], min_replicas?, log_payloads?, cors_origins?}`.
- `GET /v1/endpoints`. `GET`, `PATCH` (routes and settings) and `DELETE` on `/v1/endpoints/{name}`.
- `POST /v1/endpoints/{name}/predict` `{instances: [{…}], explain?: bool}` returns `{predictions, probabilities?, classes?, model_version, explanations?}`.
- `POST /v1/endpoints/{name}/batch` (multipart `file`, or `{dataset_id}`) returns a job. `GET /v1/endpoints/{name}/batch/{job_id}` downloads the CSV.
- `GET /v1/endpoints/{name}/openapi.json`.
- `GET /v1/endpoints/{name}/metrics` returns `{requests, errors, p50_ms, p95_ms, p99_ms, by_version}`.

## Model Training Studio, registry and serving: P1 additions
All additions are backward compatible: existing request and response fields keep their meaning.

### Training configuration (added fields on `POST /v1/experiments`)
```
{ target?: string,                       // now optional, but only for clustering
  problem_type?: binary|multiclass|regression|clustering|forecasting,
  preprocessing: { ...,
    auto_features?: {interactions: true, polynomial: true, top_k: 5},   // FE-001: a×b and a² terms of the top-k numeric features
    pca?: {n_components: 0.95} },        // FE-005: <1 = share of variance kept, >=1 = number of components
  ensemble: {enabled?: bool|null, methods: ["stacking","voting"], top_k: 3},  // TRN-005; null = on when AutoML picked the algorithms
  clustering?: {k_min: 2, k_max: 8, max_fit_rows: 5000},              // TRN-006
  forecast?: {time_column, frequency?: pandas alias (D, W-SUN, MS, h, …; empty = detect), horizon: 12,
              season_length?: int, backtest_folds: 3, interval_level: 0.9, aggregation: mean|sum|last} }  // TRN-007
```
- New algorithm ids:
  - Supervised: `catboost` (TRN-002a).
  - Ensembles: `stacking_ensemble` and `voting_ensemble` (TRN-005). They're added automatically as extra runs over the best `top_k` candidates. Their `params` are `{base: [{algorithm, params}]}` and their artifacts include `ensemble_members`.
  - Clustering: `kmeans`, `dbscan`, `agglomerative`, `gmm`.
  - Forecasting: `seasonal_naive`, `exponential_smoothing`, `sarima`, `gbm_forecast`.
- `GET /v1/algorithms` lists all of them. Each entry's `problem_types` says where it applies.
- `POST /v1/experiments/detect` (MDL-002a):
  - `target` is optional. Without a target it returns `{problem_type: "clustering"}`.
  - A numeric target on a regular date index also returns `alternatives: [{problem_type: "forecasting", time_column, frequency, reason}]`.

### Run metrics and artifacts
- **Clustering** (EXP-005):
  - `metrics`: `{silhouette, calinski_harabasz, davies_bouldin, n_clusters, noise_fraction, n_rows, cv_metric: "silhouette"}`.
  - `artifacts`: `cluster_sizes [{cluster, size, share}]`, `projection {x, y, cluster, explained_variance}` (a 2-D PCA sample), `cluster_profiles [{cluster, size, means: {feature: mean}, top_categories: {feature: value}}]`, `overall_means`, and `k_search [{params, cv_score, silhouette, …}]`.
  - Cluster `-1` is DBSCAN noise.
- **Forecasting** (EXP-004):
  - `metrics`: `{mae, rmse, mase, smape, coverage, interval_width, n_backtest_points, folds, horizon, cv_metric: "mase"}`. These come from a rolling-origin backtest.
  - `artifacts`:
    - `history {timestamps, values}`
    - `backtest [{origin, timestamps, actual, forecast, lower, upper}]`
    - `forecast {timestamps, forecast, lower, upper, interval_level}`
    - `frequency` and `season_length`
- **Classification and regression**: `artifacts.ale {feature: {grid, ale, counts}}` holds first-order accumulated local effects for the top numeric features (XAI-001a).
- `POST /v1/runs/{id}/explain` (XAI-002a) also returns:
  - `force_plot: [{base_value, output_value, features: [{feature, value, shap, direction: up|down}]}]`. Features are ordered by |SHAP|.
  - `lime: [{prediction, local_prediction, intercept, r2, weights: [{feature, value, weight}], explained_class?}]`. This is a weighted linear local surrogate, computed for the first 10 instances.
  - Clustering and forecasting runs return 422.

### ONNX export (MDL-NFR-004)
- `GET /v1/runs/{id}/onnx` downloads `application/octet-stream`.
- Eligible pipelines have numeric features only, scaling set to standard, minmax, robust or none, and no `auto_features`. PCA and feature selection are allowed. The model can be scikit-learn, XGBoost or LightGBM, including voting and stacking ensembles of those.
- Inputs: one `float32 [N,1]` tensor per numeric feature. Classifier labels are class indices; the class names are in the `ap.classes` metadata.
- Anything else returns 409 with `detail = {code: "onnx_unsupported", message}`, for example categorical or date features, CatBoost, clustering or forecasting.

### Training templates (CFG-007)
- `GET /v1/training-templates`.
- `POST /v1/training-templates` `{name, description?, config}` returns 201 `{id, name, description, config, created_by, created_at}`.
  - `config` is a TrainingConfig, and `target` may be left out.
  - A duplicate name returns 409. An invalid config returns 422.
- `GET`, `PATCH {description?, config?}` and `DELETE` on `/v1/training-templates/{id}`.
- `POST /v1/training-templates/{id}/apply` `{name, dataset_id, dataset_version?, overrides: {target, …}}` returns 202 `{experiment, job, template_id}`. The overrides are deep-merged over the template.

### Serving
- `POST /v1/endpoints/{name}/predict` on a **forecasting** endpoint:
  - Request: `{horizon?: 1..1000 (default: the trained horizon), history?: [{<time_column>|timestamp, <target>|value}]}`. `history` is recent observations; the model is refit with them.
  - Response: `{horizon, timestamps[], predictions[], lower[], upper[], interval_level, model_version}`.
  - `instances` is not needed.
  - Batch jobs on forecasting endpoints fail with a permanent error.
- **Clustering** endpoints return integer cluster ids in `predictions`. `-1` means noise, and only DBSCAN produces it; DBSCAN assigns new points to the nearest core point within `eps`.
- `explain: true` returns 422 on clustering and forecasting endpoints.
- `/openapi.json` describes the forecasting request and response for forecasting endpoints.
- Drift monitoring (API-011):
  - What is stored:
    - Registering a model stores a training reference profile in the version's signature (`reference_profile`). It has numeric decile bins, top-20 categories, and the prediction distribution.
    - Every successful prediction feeds a bounded reservoir sample (500 instances per endpoint per day, kept 30 days), whatever `log_payloads` is set to.
    - Only drift tokens are stored (the bin index or a known category). Raw values are never stored, and PII-tagged features are skipped.
  - `GET /v1/endpoints/{name}/drift?hours=24` returns `{endpoint, window_hours, thresholds: {warn: 0.1, alert: 0.25}, min_samples: 30, samples, status, model_version, features: [{feature, type, psi, status, bins, expected, actual, samples}], prediction: {psi, status, bins, expected, actual}, by_version}`.
    - `status` is one of `ok`, `warn`, `alert`, `insufficient_data`, `no_data` or `not_applicable` (forecasting).
  - `POST /v1/endpoints/{name}/drift/check` `{hours?}` checks one endpoint. `POST /v1/endpoints/drift-checks` `{hours?}` checks every active endpoint; point a scheduler at it.
    - Both return 202 with a `serving.drift_check` job. Its result is `{checked: [{endpoint, status, samples}], alerts: [...]}`.
    - Every endpoint in alert raises an `endpoint.threshold` notification and webhook: `{endpoint, kind: "drift", status: "alert", window_hours, threshold, features: [{feature, psi}], prediction_psi}`.

## Saved analytics
- `POST /v1/analytics` `{dataset_id, name, sql, chart: {type, x, y, series?, aggregation?}, parameters: [{name, type: string|number|date, default}]}`.
- `GET /v1/analytics`, `GET` / `DELETE` on `/v1/analytics/{id}`.
- `POST /v1/analytics/{id}/run` `{params: {name: value}}` returns `{columns, rows}`. Parameters are referenced as `:name` in the SQL.

## Dashboards
- `POST /v1/dashboards` `{name, spec}`. `GET /v1/dashboards?archived=`.
- `GET`, `PUT {name?, spec?}` and `DELETE` on `/v1/dashboards/{id}`.
- `POST /v1/dashboards/{id}/clone`, `/archive`, `/share {user_id, role: editor|viewer}`.
- `POST /v1/dashboards/{id}/widgets/{widget_id}/data` `{filters: {column: value | [values] | {min, max}}}` returns `{columns, rows}`.
- `POST /v1/dashboards/{id}/export` `{filters}` returns a standalone interactive HTML file. JSON export is `GET /v1/dashboards/{id}`; PNG and PDF are rendered in the browser.
- `POST /v1/dashboards/{id}/embed-token` `{ttl_minutes}` returns `{token}`. Then `GET /v1/embed/{token}` and `POST /v1/embed/{token}/widgets/{wid}/data` need no credentials.
- `GET /v1/dashboards/templates`.
- `spec`:

```
{ "pages": [ { "id": "p1", "title": "Overview",
      "widgets": [ { "id": "w1", "type": "chart|kpi|table|text|filter|image|prediction|alert",
                     "title": "...", "layout": {"x":0,"y":0,"w":6,"h":4},
                     "config": { "analytic_id?": "...", "dataset_id?": "...", "sql?": "...",
                                 "chart?": {"type":"bar|line|area|scatter|pie|heatmap|histogram|box|treemap|funnel|gauge|sankey|waterfall",
                                            "x":"col","y":"col","series?":"col","aggregation?":"sum|avg|count|min|max"},
                                 "kpi?": {"value":"col","target?":123,"trend?":"col"},
                                 "text?": "markdown", "image_url?": "...",
                                 "filter?": {"column":"region","kind":"dropdown|multiselect|slider|date","dataset_id":"..."},
                                 "endpoint?": "name", "thresholds?": [{"op":">","value":100,"color":"red"}],
                                 "conditional_format?": [{"column":"x","op":">","value":1,"color":"#f00"}] } } ] } ],
  "filters": [ {"id":"f1","column":"region","kind":"multiselect","default":[]} ],
  "date_range": {"column":"order_date","default":"last_90_days"},
  "theme": {"mode":"light|dark","primary":"#4f46e5"},
  "refresh_seconds": 300 }
```

## Webhooks
- `POST /v1/webhooks` `{url, events: ["job.succeeded","job.failed","model.registered","endpoint.threshold",…]}` returns `{id, secret}`, with the secret shown once.
- `GET /v1/webhooks`. `DELETE /v1/webhooks/{id}`.
- `GET /v1/webhooks/{id}/deliveries`. `POST /v1/webhooks/deliveries/{id}/retry`.
- Deliveries are signed with a header `X-AP-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.

## Phase 2 platform features

### LLM provider health (LPA-006)
- `GET /v1/tenant/llm-health` (data.read) returns `{window_seconds, breaker, providers: [{provider, requests, errors, refusals, error_rate, refusal_rate, latency_ms: {p50, p95, max}, last_outcome, seconds_since_last, breaker: closed|open|half_open, status: healthy|degraded|unhealthy}]}` over a rolling window.
- `PUT /v1/tenant/llm-health/breaker` (admin) `{enabled, failure_threshold, open_seconds}`. The circuit breaker is off by default (platform default: `AP_LLM_BREAKER_ENABLED`). When it is on, a provider with `failure_threshold` consecutive errors is skipped for `open_seconds`, then gets one half-open probe. Refusals never trip it, and if every provider is open the chain is tried anyway.
- `GET /v1/platform/llm-health` (platform operators, `AP_PLATFORM_ADMIN_EMAILS`) returns the same stats aggregated across tenants, plus `open_breakers`.

### Prompt templates (LPA-008)
- `GET /v1/prompts` returns `[{template_id, description, variables, default: {ref, system}, effective: {ref, source: default|platform|tenant}}]`. The templates are `schema.from_text`, `analytics.suggest` and `model.explain`.
- `GET /v1/prompts/{template_id}` adds `tenant_versions[]` and `platform_versions[]` (`{ref, version, provider, scope, active, description, system, created_by, created_at}`).
- `POST /v1/prompts/{template_id}/versions` (admin) `{system, provider?: anthropic|openai|openai_compatible|gemini|mock, description?}` creates a tenant override. It is active immediately and returns `ref` (for example `schema.from_text@2`).
  - Placeholders are `{{name}}` and must match the template's `variables` exactly.
  - Resolution order: the tenant's provider-specific version, then the tenant's any-provider version, then the platform's provider-specific version, then the platform's any-provider version, then the shipped default.
  - The effective `ref` is recorded as `template` in every `llm.call` audit entry.
- `POST /v1/prompts/{template_id}/versions/{version}/deactivate` or `/activate` (admin).
- `POST /v1/platform/prompts/{template_id}/versions` (platform operators) creates a platform-wide override.

### Notifications (NTF-002, NTF-003)
- `GET`/`PUT /v1/notifications/preferences` `{email: [kinds]}` lists the kinds emailed to the calling user. Kinds are `job.succeeded`, `job.failed`, `model.registered`, `endpoint.deployed`, `dataset.version_created`, `endpoint.threshold` and `*`. Only users can call it (API clients get 400).
- Email goes out from `notification.email` jobs, so requests never wait on SMTP. `AP_EMAIL_SENDER` is `console` (the default), `smtp` or `memory`.
  - SMTP settings: `AP_SMTP_HOST`, `AP_SMTP_PORT`, `AP_SMTP_USERNAME` and `AP_SMTP_FROM`. The password is the platform secret `smtp-password`.
  - SMTP always uses STARTTLS with a verified certificate.
- `POST /v1/tenant/chat-destinations` (admin) `{kind: slack|teams, name, url, events[]}` returns `{id, kind, name, host, events, active, created_at}`.
  - The incoming-webhook URL is kept in the secret manager and never returned.
  - It must be https on `hooks.slack.com` (Slack) or `*.webhook.office.com` / `*.logic.azure.com` (Teams), and it passes the webhook SSRF guard.
  - Posts go out from `notification.chat` jobs with retries.
- `GET /v1/tenant/chat-destinations`. `DELETE /v1/tenant/chat-destinations/{id}`.

### OAuth 2.0 client credentials (MGT-004a)
- `POST /v1/tenant/oauth-clients` (endpoints.deploy; admin role needs admin) `{name, role, scopes[]}` returns `{id, client_id, client_secret, role, scopes, token_url, …}`. The secret is shown once and only its hash is stored.
- `GET /v1/tenant/oauth-clients`. `DELETE /v1/tenant/oauth-clients/{id}` revokes the client; its tokens stop working immediately.
- `POST /oauth/token` (form-encoded) `grant_type=client_credentials[&scope=a b]`, with credentials via HTTP Basic or `client_id` + `client_secret` fields.
  - Returns `{access_token, token_type: "bearer", expires_in, scope}` with `Cache-Control: no-store`. The lifetime is `AP_OAUTH_TOKEN_TTL`, 900 s by default.
  - Errors follow RFC 6749: `{error: invalid_request|invalid_client|unsupported_grant_type|invalid_scope, error_description}`.
- Use the token as `Authorization: Bearer <access_token>`. `GET /v1/auth/me` shows `method: "oauth_client"`, and scopes narrow the role's permissions exactly like API-key scopes.

### IP allowlist / denylist (MGT-007)
- `GET`/`PUT /v1/tenant/network-policy` (admin) `{allow: [CIDR], deny: [CIDR]}`.
  - Deny wins. A non-empty allowlist blocks every other address.
  - The policy applies to every tenant principal: users, API keys, OAuth clients and SCIM.
  - Blocked calls get 403 `{detail: {code: "ip_denied"}}`.
  - A policy that would block the caller's own IP is refused with 409.

### Teams (AUTH-004)
- `POST /v1/teams` (admin) `{name, description?, members[]}`. `GET /v1/teams`, `GET /v1/teams/{id}` return `{id, name, description, members[], projects[]}`. `DELETE /v1/teams/{id}` (admin).
- `POST /v1/teams/{id}/members` `{user_id}`. `DELETE /v1/teams/{id}/members/{user_id}` (admin).
- `POST /v1/projects/{project_id}/teams` `{team_id}` and `DELETE /v1/projects/{project_id}/teams/{team_id}` (admin). Every member of a granted team can see the project.

### SCIM 2.0 provisioning (AUTH-001a)
- `POST /v1/tenant/scim-token` (admin) returns `{token, base_url: "/scim/v2"}`. The token is shown once, and creating a new one rotates it.
- `GET /v1/tenant/scim-token` returns `{configured, created_at, created_by}`. `DELETE /v1/tenant/scim-token` revokes it.
- SCIM calls send `Authorization: Bearer scim_<tenant>_…`:
  - `GET /scim/v2/ServiceProviderConfig`.
  - `GET /scim/v2/Users?filter=userName eq "x"|externalId eq "x"&startIndex=&count=` returns a ListResponse.
  - `GET`, `PUT` and `PATCH` on `/scim/v2/Users/{id}`. PATCH accepts `add`/`replace` on `active`, `displayName`, `name.formatted`, `externalId` and the role.
  - `POST /scim/v2/Users`.
  - `DELETE /scim/v2/Users/{id}` disables the user.
- The role is the custom attribute `urn:ietf:params:scim:schemas:extension:analyticsplatform:2.0:User` `{role}`.
- Provisioned users have no password; they sign in with SSO.
- The last active admin can't be disabled or demoted (409, `scimType: mutability`).
- SAML 2.0 is not implemented yet.

### Public dashboard links (SHR-001a)
- `POST /v1/dashboards/{id}/public-links` (dashboard editor or owner) `{ttl_hours: 1..8760, default 168}` returns `{id, token, path, expires_at, status, …}`. The token is shown once and only its hash is stored.
- `GET /v1/dashboards/{id}/public-links` returns `[{id, status: active|expired|revoked, created_by, created_at, expires_at, revoked_at}]`. `DELETE /v1/dashboards/{id}/public-links/{link_id}` revokes a link.
- Anonymous endpoints, rate-limited per IP:
  - `GET /v1/public/{token}` returns the dashboard without owner or share lists.
  - `POST /v1/public/{token}/widgets/{widget_id}/data` `{filters}` returns the same data as signed-in viewers get.
- `GET`/`PUT /v1/tenant/sharing` (admin) `{public_links_enabled}`. Disabling it immediately stops every existing link.

### Consent (SEC-003, SOC-PRV-005)
- `POST /v1/consents` `{policy: terms|privacy|llm_processing, version}` records the calling user's consent with a timestamp and IP. Users only; API clients get 400.
- `GET /v1/consents` lists your consents. `DELETE /v1/consents/{policy}` withdraws consent; the record is kept.
- `GET /v1/tenant/consents?policy=` (admin) lists consents across the tenant.
- `GET`/`PUT /v1/tenant/consent-settings` (admin) `{llm_requires_consent, llm_addendum_version}`. The response adds `llm_consent_given`.
  - While consent is required and no admin has an active `llm_processing` consent at that version, every LLM feature returns 409 `{detail: {code: "llm_consent_required", message}}`.

### Cost attribution (OBS-004)
- `GET /v1/tenant/costs?start=YYYY-MM-DD&end=YYYY-MM-DD` (admin; defaults to month to date, at most 366 days) returns:
  - `{start, end, currency: "USD", rates, total_cost_usd}`
  - `llm: {cost_usd, by_model, input_tokens, output_tokens, unpriced_requests}`
  - `compute: {seconds, cost_usd, by_job_type}`
  - `storage: {bytes, gb_months, cost_usd, basis}`
  - `api: {requests, cost_usd, by_key}`
- The rates come from `AP_COST_COMPUTE_USD_PER_SECOND`, `AP_COST_STORAGE_USD_PER_GB_MONTH` and `AP_COST_API_USD_PER_1K_REQUESTS`.
- Storage is the tenant's current stored bytes, prorated over the range.

### Incoming webhooks (WHK-002)
- `POST /v1/inbound-hooks` (admin) takes one of two bodies:
  - `{name, action: "predict", endpoint}`
  - `{name, action: "ingest", dataset_id, mode: append|replace}`
  - Returns `{id, path: "/hooks/in/{tenant}/{id}", secret, …}`. The secret is shown once.
- `GET /v1/inbound-hooks`. `DELETE /v1/inbound-hooks/{id}` deactivates the hook and deletes its secret.
- `POST /hooks/in/{tenant}/{id}` takes no credentials.
  - The body is `text/csv`, or `application/json` as `[{…}]` or `{rows: [{…}]}`, up to 50 MB.
  - It must be signed with `X-AP-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`, the same scheme as outgoing webhooks. Signatures older than 5 minutes and replays are rejected with 401.
  - Returns 202 with the job:
    - `predict` runs `serving.batch_predict`; fetch its result with `GET /v1/endpoints/{name}/batch/{job_id}`.
    - `ingest` runs `inbound.ingest`, which creates the next dataset version with the rows appended (or replacing the contents).
