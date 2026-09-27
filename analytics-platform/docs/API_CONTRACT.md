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

## Phase 2 data layer

### SQL DDL schemas (SCH-004)
- `POST /v1/schemas/parse` also accepts `format: "sql_ddl"`: `CREATE TABLE` statements (PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, BigQuery, Snowflake).
  - Column types map to canonical types (`VARCHAR(n)` → `max_length`, `DECIMAL`/`NUMERIC` → number, `ENUM(...)`/`CREATE TYPE … AS ENUM` → enum, `INT[]`/`ARRAY<T>` → array).
  - `NOT NULL`, `PRIMARY KEY` and `UNIQUE` (inline and table-level), `FOREIGN KEY`/`REFERENCES` (inline, table-level and `ALTER TABLE … ADD FOREIGN KEY`).
  - `CHECK` with comparisons, `BETWEEN`, `IN (…)`, `= ANY (ARRAY[…])`, OR-ed equalities and `length(col)` → `minimum`/`maximum`/`enum`/`min_length`/`max_length`. `DEFAULT` is ignored.
  - Errors and warnings carry `path: "line:col"`. Composite keys, unmappable `CHECK`s and unknown statements are warnings.

### Schema history (SCH-010)
- `POST /v1/schemas` `{name, schema, project_id?, message?, source_format?}` returns `{schema_record, version, created, diff?}`: 201 with a new version when the content changed, 200 with `created: false` when it's identical to the latest version.
- `GET /v1/schemas?project_id=` lists saved schemas: `[{id, project_id, name, current_version, created_by, created_at, updated_at}]`.
- `GET /v1/schemas/{id}` (with `versions[]`), `GET /v1/schemas/{id}/versions`, `GET /v1/schemas/{id}/versions/{version}` (with `schema`).
- `GET /v1/schemas/{id}/diff?from_version=&to_version=` (default: previous → latest). `POST /v1/schemas/diff` `{a, b}` diffs two arbitrary schemas.
- SchemaDiff: `{identical, added_entities[], removed_entities[], entities: [{name, added_fields[{name,type,nullable}], removed_fields[], retyped_fields[{field, from_type, to_type}], changed_fields[{field, attribute, from, to}]}], breaking, summary[]}`.
- Project access applies as for datasets (404 when the caller can't see the project).

### Generation options (GEN-006, GEN-009, GEN-008a)
- `options.distributions`: `{"entity.field": {kind: uniform|normal|lognormal|weights, mean?, std?, sigma?, weights?: {value: weight}}}`. Numeric draws are clipped to the field's `minimum`/`maximum`. `weights` works for enums (keys are enum values) and for categories. Output stays seeded and prefix-stable.
- `options.anomaly_rate` (0–0.5, default 0): replaces that share of values in non-key fields with edge cases (out-of-range numbers, empty/odd strings, 1900/2099 dates).
- `format: "xml"` exports `<entity><row><field>…</field></row>…</entity>` (nulls omitted, arrays as `<item>`).

### Uploads (ING-003a, ING-006, CLN-009, INF-004/005)
- Also accepted: `.xls`, Avro, ORC and XML. These are converted to a Parquet working copy. XML records are the repeated elements, and the first group of repeated child elements becomes one row per child.
- Compressed uploads: `.gz`, `.zip`, `.tar`, `.tar.gz`/`.tgz`. Each data file in an archive becomes one table of the dataset.
  - The 1 GB limit applies to the uncompressed size (413).
  - Compression ratios above 100:1, path traversal, links and nested archives are rejected (422).
- Non-UTF-8 text (e.g. Windows-1252, Shift-JIS, UTF-16) is transcoded to UTF-8.
- TableRecord gains `source_format?`, `source_encoding?`, `raw_file?` (the untouched upload, when the table was derived) and `notes[]`. Notes are also added to `inference.warnings`.
- Multi-table datasets: the inferred schema has one entity per table.
  - Primary keys are detected per table.
  - Foreign keys are detected across tables (name similarity plus ≥ 95% value containment).
  - `inference.relationships` lists `{child_entity, child_field, parent_entity, parent_field, name_score, containment}`. `inference.columns[].table` names each column's table.

### Dataset versions and schema evolution (INF-007, INF-008)
- `POST /v1/datasets/{id}/versions?mode=append|replace` (multipart `file`) returns `{dataset, previous_version, mode, inference, diff}` (201). The upload becomes the next version.
  - `append` (default): the file's rows are appended to the matching table (`UNION ALL BY NAME`), and other tables are carried over.
  - `replace`: only the file's tables are kept.
- `diff` is a SchemaDiff of the columns (added, removed, retyped, nullability). The new version's schema keeps the previous confirmed definitions and annotations for columns whose type didn't change.

### Column annotations (ANA-010)
- `GET /v1/datasets/{id}/annotations?version=` returns `{dataset_id, version, annotations: {entity: {field: [pii|sensitive|derived|target|id]}}}`.
- `PUT /v1/datasets/{id}/annotations` `{columns: {column: [annotation]}, entity?, version?, replace: true}`.
  - Annotations are stored on the version's schema (`Field.annotations`).
  - `pii`/`sensitive` also set `pii: true`. Annotations never clear an existing PII flag.

### Advanced profiling (ANA-004a, ANA-005a, ANA-008)
- `POST /v1/datasets/{id}/profile/advanced?version=&table=` with the body below. Every section is on by default; pass `{enabled: false}` to skip one.

```
{isolation_forest?: {enabled, contamination: "auto"|0<x≤0.5, n_estimators, max_rows ≤ 200000, columns?, seed},
 near_duplicates?: {enabled, columns?, threshold: 0.5–1, window, max_rows},
 missing_patterns?: {enabled, alpha, max_rows, max_columns}}
```

- Response: `{row_count, isolation_forest?, near_duplicates?, missing_patterns?}`.
  - `isolation_forest`: `{columns, contamination, sampled_rows, total_rows, outlier_count, outlier_fraction, examples[{row, score, values}]}`. Numeric columns only.
  - `near_duplicates`: `{columns, threshold, method, rows_scanned, sampled, pair_count, cluster_count, duplicate_rows, examples[{rows, score, values}]}`.
  - `missing_patterns`: `{heuristic: true, method, rows_analyzed, columns, missing_fraction, co_missingness, indicator_correlation, patterns[{missing_columns, count, fraction}], mechanisms[{column, missing_fraction, label: "MCAR (heuristic)"|"MAR (heuristic)"|"insufficient data", associated_with, min_adjusted_p_value, evidence}]}`.
- New cleaning step:

| op | Fields |
|----|--------|
| `fuzzy_deduplicate` | `columns` (default: all columns except surrogate ids), `threshold` (0.5–1, default 0.9), `window` (blocking, default 10), `keep`: first \| last |

### Connectors (ING-007)
- `POST /v1/connectors` `{name, kind: s3|gcs|postgresql|mysql, config, credentials}` returns `{id, name, kind, config, created_by, created_at}` (201).
  - `config`: s3/gcs `{bucket, region?, project?, endpoint_url?}`; databases `{host, port?, database, sslmode?}`.
  - `credentials`: s3 `{access_key_id, secret_access_key, session_token?}`; gcs `{service_account_json}`; databases `{username, password}`.
  - Credentials are written to the secret store and never returned.
- `GET /v1/connectors`, `GET` and `DELETE` on `/v1/connectors/{id}`.
- `POST /v1/connectors/{id}/import` `{project_id?, name?, key? | prefix?, query?, row_limit?}` returns a job (202). The job's result is `{dataset_id, version, tables[{name, row_count, size_bytes}], warnings[]}`.
  - Object storage: `key` (one object) or `prefix` (up to 100 objects, one table each).
  - Databases: `query` must be a single SELECT. It runs in a read-only transaction with a statement timeout, capped at `row_limit` (≤ `AP_CONNECTOR_MAX_ROWS`) and at 1 GB.
- SSRF guard: hosts resolving to private addresses are rejected (422) unless allowlisted with `GET`/`PUT /v1/connectors/allowlist` `{hosts: [hostname | *.suffix | CIDR]}` (admin only). Loopback, link-local and metadata addresses can only be opened by the platform setting `AP_CONNECTOR_HOST_ALLOWLIST`.
- `sqlite` connectors exist only for tests and local development (`AP_CONNECTOR_ALLOW_SQLITE=1`). MySQL needs the `connectors` extra (PyMySQL).

## Phase 3: ML & serving
All additions are backward compatible.

### Anomaly detection (MDL-002b, TRN-008)
- `POST /v1/experiments` accepts `problem_type: "anomaly"`. `target` is optional and names a **label column used only for evaluation** (never a feature).
  - `anomaly?: {contamination?: 0<x≤0.5 (default: the label rate, else 0.05), threshold: contamination|f1, positive_label?, max_fit_rows: 5000}`. `threshold: "f1"` needs labels and picks the score that maximizes training F1.
  - Algorithms: `isolation_forest`, `one_class_svm`, `lof` (novelty mode) and `autoencoder` (MLP reconstruction error). All report an anomaly score where **higher = more anomalous**.
  - Model selection: PR-AUC on the held-out rows when labels exist; otherwise agreement with the consensus ranking of all detectors (`cv_metric: "consensus"`). AutoML tunes hyperparameters only when labels exist.
  - `metrics`: `{n_test, threshold, anomaly_rate, score_mean, score_p95, contamination, cv_metric}`, plus `{precision, recall, f1, roc_auc, pr_auc, label_rate}` when labels exist.
  - `artifacts`: `score_distribution {edges, counts, counts_normal?, counts_anomaly?}`, `threshold`, `feature_importance [{feature, importance, direction}]` (standardized mean difference, flagged vs normal) and `top_anomalies [{row, score}]`. With labels also `roc_curve`, `pr_curve` and `confusion_matrix`.
- `POST /v1/experiments/detect`:
  - Without a target the response adds `alternatives: [{problem_type: "anomaly"}]`.
  - A binary target whose minority class is ≤ 5 % (or is named fraud / anomaly / outlier …) adds `{problem_type: "anomaly", label_column, positive_label, reason}`.
- Serving: `predictions: [{is_anomaly, score}]` plus `threshold`. Batch output has `is_anomaly` and `anomaly_score` columns. Drift monitors the `is_anomaly` rate. `explain: true` and `/explain` return 422; `/onnx` returns 409 `onnx_unsupported`.

### Fairness (XAI-004)
- Classification runs store their held-out test labels, predictions and candidate protected attributes: numeric columns and columns with ≤ 50 values. PII-tagged columns are stored only when listed in the new training field `fairness: {protected: [...]}`.
- `POST /v1/runs/{id}/fairness` `{protected: [column, …] (1–20), positive_class?, min_group_size: 10}` returns:
  ```
  {run_id, positive_class, n_test, min_group_size,
   attributes: [{attribute, grouping: categories|quartiles,
                 groups: [{group, n, selection_rate, base_rate, tpr, fpr, precision, accuracy, selection_ratio, small_group}],
                 demographic_parity_difference, demographic_parity_ratio, equalized_odds_difference,
                 four_fifths_rule: {threshold: 0.8, passed, flagged_groups}}]}
  ```
  - Any dataset column works, feature or not. Columns not stored with the run are read from the run's dataset version.
  - Numeric attributes with > 10 values are split into quartiles.
  - Groups smaller than `min_group_size` are reported but left out of the summary metrics.
  - `positive_class` defaults to the second class (binary) or the rarest class (multiclass).
  - 422: not a classification run, an unknown column, the target as an attribute, or an unknown class. 409 `holdout_missing`: the run was trained before this feature.

### Text features (FE-006) and projections (FE-005a)
- `preprocessing.text?: {method: "tfidf", max_features: 200, ngram_max: 1, svd_components?: int, columns?: [..]}` includes free-text columns (otherwise dropped) as TF-IDF features inside the served pipeline, optionally reduced with TruncatedSVD.
  - Without `columns`, schema TEXT columns and multi-word string columns are used. Primary keys and `*_id` columns stay dropped.
  - The feature signature group is `text`. SHAP values and importances aggregate back to the source column.
  - Text pipelines are not ONNX-exportable (409).
- `POST /v1/datasets/{id}/projection?version=` and `POST /v1/runs/{id}/projection`:
  - Body: `{method: auto|umap|tsne|pca, features?, color_by?, sample: 10–5000 (default 2000), perplexity, n_neighbors, seed}`.
  - Response: `{method, n, total_rows, x[], y[], color_by?, color?[], features?, actual?, note}`.
  - `auto` means UMAP when `umap-learn` is installed (the `ml-extra` extra), else t-SNE.
  - Dataset projections leave PII columns out unless they are listed in `features`.
  - Run projections use the run's fitted preprocessing and colour points by the model's predictions; `actual` is the target.
  - Projections are for visualization only. Forecasting runs and uploaded models return 409.

### Custom model upload (TRN-010, SEC-010)
- `POST /v1/models/upload` (multipart, needs `models.train`): `file` (ONNX, ≤ 200 MB), `signature` (JSON), `name`, `description?`, `dataset_id?`. Returns 201 `{model_id, name, version, model_version_id, stage, run_id, sha256, input_mode, reference_dataset_id}`.
  - `signature`: `{problem_type: binary|multiclass|regression, target?, classes? (classification), features: [{name, type: number|integer|string|boolean, categories?, min?, max?}], input: auto|per_feature|tensor, outputs?: {label?, probabilities?, value?}}`.
  - Inputs are either one `[N,1]` tensor per feature, named after it (what `/onnx` exports), or one float `[N,F]` tensor in signature order. Labels may be class values or class indices. Probabilities may be a matrix or a ZipMap.
  - Validation:
    - Pickle, joblib and zip payloads are refused.
    - The file must parse as ONNX, pass `onnx.checker`, embed its weights (no external data) and use only the standard operator domains.
    - It is loaded in onnxruntime and dry-run on a synthetic row built from the signature, then on reference rows.
    - Failures return 422 `{code: "model_rejected", message}`. A file that is too large returns 413.
  - Reference data: the `dataset_id` rows, or 100 synthetic rows saved as a small `model_upload` dataset. They feed drift monitoring and explanations.
- The model becomes an ordinary registry version (algorithm `onnx_upload`, signature `source: "upload"`). It is deployed and served through the normal endpoint APIs.
  - `explain` uses SHAP's KernelExplainer on 20 background rows.
  - `/v1/runs/{run_id}/onnx` returns the uploaded file.
  - Uploaded models are never deserialized with pickle or joblib.

### Canary rollouts (API-009)
- `POST /v1/endpoints/{name}/canary` (needs `endpoints.deploy`) `{model_version_id, steps: [5, 25, 50, 100], step_minutes: 10, max_error_rate: 0.05, max_p95_ms_increase: 200, min_requests: 20}` returns 201 with the rollout.
  - The candidate gets `steps[0]` % of traffic; the current routes share the rest proportionally.
  - A final 100 is appended to `steps` when it is missing.
  - 409 when a rollout is already running.
- For each step, a `serving.canary_step` job compares the canary with the baseline over the prediction logs written since the step began:
  - **Rollback** when the canary's error rate (status ≥ 400) is above `max_error_rate`, or its p95 latency is more than `max_p95_ms_increase` ms above the baseline's. The baseline routes are restored, an `endpoint.threshold` notification and webhook `{endpoint, kind: "canary", status: "rolled_back", canary_id, reason, canary, baseline}` is sent, and `endpoint.canary.rollback` is audited.
  - **Hold** when the canary has fewer than `min_requests` requests. It is re-evaluated after max(step, 60 s).
  - Otherwise **ramp** to the next step, or **complete** at 100 % (the routes become the candidate only).
- `GET /v1/endpoints/{name}/canary` returns the latest rollout: `{id, endpoint, status: running|completed|rolled_back|aborted, candidate, baseline_routes, steps, step_index, weight, thresholds, reason, history[], step_started_at, next_eval_at, live?: {canary, baseline}}`.
- `POST /v1/endpoints/{name}/canary/promote` gives the candidate 100 %. `POST /v1/endpoints/{name}/canary/abort` restores the baseline. Both return 409 when no rollout is running. `PATCH` on an endpoint's routes returns 409 while a rollout runs.
- Scheduling: the platform has no scheduler, so each step job **re-enqueues itself with a delay** (`not_before` in its params, `next_eval_at` in the database).
  - In-process, this uses a timer thread. Timers don't survive restarts, so `POST /v1/endpoints/canary-steps` (202, a job) evaluates every due rollout. Point Cloud Scheduler or cron at it every minute in production.
  - Early or duplicate triggers are dropped.

### Streaming inference (API-006)
- `POST /v1/endpoints/{name}/predict/stream` (needs `endpoints.predict`) takes the `predict` body plus `chunk_size: 1–1000` (default 100) and up to 10,000 `instances`. It returns `text/event-stream`:
  - `start {endpoint, total, chunk_size}`, then one `prediction {offset, count, predictions, probabilities?, classes?, model_version}` per chunk (`chunk_size` 1 = one event per instance), then `done {total}`.
  - Forecasting endpoints send `start {endpoint, horizon, model_version}`, one `forecast {step, timestamp, prediction, lower, upper}` per horizon step, then `done`.
  - Errors mid-stream arrive as `error {status, detail}`.
  - Each chunk after the first costs one request against the caller's rate limit (429 in an `error` event). An organization can hold at most 8 concurrent streams (429).
- `POST /v1/endpoints/{name}/stream-token` returns `{token, expires_in: 60, url}`: a single-use token bound to the caller and the endpoint.
- WebSocket `/v1/endpoints/{name}/ws`:
  - Authenticate with `?token=…`, or connect without a token and send `{"type": "auth", "api_key": …}` or `{"type": "auth", "token": <access token>}` as the first message (within 10 s).
  - The server answers `{"type": "ready"}`. Each message `{id?, instances | horizon, history?, explain?}` then gets `{id, …predict response}` or `{id, error: {status, detail}}`.
  - Every message costs one request against the rate limit.
  - Close codes: 4401 (auth), 4403 (permission or IP policy), 4404 (endpoint), 4429 (too many streams), 1009 (message > 1 MB).

### GraphQL (API-003)
- `POST /graphql`. GraphiQL is served on `GET /graphql` in dev mode only.
- Authentication, rate limits and IP policy are the same as REST. Each field checks the matching REST permission. Results are tenant-scoped, and project visibility applies to datasets and to the experiments and runs built on them.
- Queries: `datasets(projectId, limit)`, `dataset(id)`, `experiments(datasetId, limit) { runs }`, `run(id)`, `models`, `model(id) { versions }`, `endpoints`, `endpoint(name)`, `dashboards(archived)`. JSON-valued fields (`metrics`, `params`, `config`, `routes`, `signature`, `spec`) use the `JSON` scalar.
- Mutation: `predict(endpoint: String!, instances: [JSON!], horizon: Int, explain: Boolean): JSON` (needs `endpoints.predict`). It behaves exactly like REST predict, including logging, metering and drift sampling.

### gRPC (API-004)
- Runs as a separate process: `python -m app.serving.grpc_server --port 50051`.
- Service `ap.v1.Predictor/Predict` is defined in `app/serving/protos/predict.proto`. Request and response are `google.protobuf.Struct`: `{endpoint, instances, explain?, horizon?, history?}` in, the REST predict response out.
- Authenticate with metadata `x-api-key` (or `authorization: Bearer …`). Key checks, IP policy, the `endpoints.predict` permission and the rate limit are the same as REST.
- Status codes: UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT, RESOURCE_EXHAUSTED, INTERNAL.
- Run it behind TLS termination.
