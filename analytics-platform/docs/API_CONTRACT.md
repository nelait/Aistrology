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
