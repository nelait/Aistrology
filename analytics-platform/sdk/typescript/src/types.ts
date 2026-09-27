/**
 * Request and response models for the Analytics Platform API (v1).
 *
 * Hand-written from docs/API_CONTRACT.md and the backend's pydantic models. Field names match the
 * wire format (snake_case) so values can be passed through unchanged. Fields the server fills with a
 * default are optional on request types.
 */

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** A row of data keyed by column name. */
export type Row = Record<string, unknown>;
/** ISO-8601 timestamp string. */
export type Timestamp = string;

// ---------------------------------------------------------------------------------------------
// Auth and tenant
// ---------------------------------------------------------------------------------------------

export type Role = "admin" | "data_engineer" | "data_scientist" | "analyst" | "viewer";

export type Permission =
  | "tenant.manage"
  | "audit.view"
  | "data.write"
  | "pipelines.edit"
  | "data.read"
  | "analytics.create"
  | "models.train"
  | "endpoints.deploy"
  | "dashboards.edit"
  | "view"
  | "endpoints.predict";

export interface SignupRequest {
  /** Organization slug, e.g. `acme`. */
  tenant_id: string;
  org_name: string;
  email: string;
  /** At least 12 characters. */
  password: string;
  name?: string | null;
  region?: "us" | "eu";
}

export interface SignupResponse {
  tenant_id: string;
  user_id: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** TOTP code when MFA is enabled. */
  totp?: string | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  /** Access-token lifetime in seconds. */
  expires_in: number;
  token_type: string;
}

/** Codes found on `AuthenticationError.code` for login/refresh failures. */
export type AuthErrorCode =
  | "invalid_credentials"
  | "locked"
  | "mfa_required"
  | "mfa_invalid"
  | "mfa_enrollment_required"
  | "disabled"
  | (string & {});

export interface Me {
  tenant_id: string;
  id: string;
  role: Role | string;
  method: "jwt" | "api_key" | "dev" | string;
  email?: string;
  name?: string | null;
  mfa_enabled?: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  region: string;
  plan: string;
  status: string;
  require_mfa: boolean;
  quotas: Record<string, number>;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  cloud_provider: string;
}

export interface TenantPatch {
  name?: string | null;
  require_mfa?: boolean | null;
  quotas?: Record<string, number> | null;
}

export interface TenantDeletion {
  [key: string]: unknown;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role | string;
  mfa_enabled: boolean;
  disabled: boolean;
}

export interface UserCreate {
  email: string;
  role: Role;
  password: string;
  name?: string | null;
}

export interface UserPatch {
  role?: Role | null;
  disabled?: boolean | null;
}

export interface ApiKey {
  id: string;
  name: string;
  /** First characters of the key, for display. */
  prefix: string;
  role: Role | string;
  scopes: Permission[] | string[];
  rate_limit_per_minute: number;
  allowed_ips: string[];
  created_at: Timestamp;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
}

/** Returned on create/rotate: `key` is the secret, shown only once. */
export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

export interface ApiKeyCreate {
  name: string;
  role?: Role;
  /** Optional narrowing of the role's permissions. */
  scopes?: Permission[];
  rate_limit_per_minute?: number;
  expires_in_days?: number | null;
  allowed_ips?: string[];
}

export type ProviderKind = "openai" | "openai_compatible" | "anthropic" | "gemini" | "mock";
export type DataMinimization = "L0" | "L1" | "L2" | "L3";

export interface ProviderConfig {
  kind: ProviderKind;
  model?: string | null;
  base_url?: string | null;
  /** Name of a secret stored with `tenant.secrets.put`. */
  secret_name?: string | null;
}

export interface LLMConfig {
  chain?: ProviderConfig[];
  data_minimization?: DataMinimization;
  cache_enabled?: boolean;
}

export interface LLMUsage {
  by_model: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number; [key: string]: unknown }>;
  total_cost_usd: number;
  total_tokens: number;
}

export interface Usage {
  storage_bytes: number;
  counters: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  at: Timestamp;
  tenant_id: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

// ---------------------------------------------------------------------------------------------
// Canonical schema
// ---------------------------------------------------------------------------------------------

export type FieldType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "array";
export type ColumnRole = "identifier" | "categorical" | "continuous" | "datetime" | "text" | "boolean";
export type Semantic =
  | "email"
  | "phone"
  | "first_name"
  | "last_name"
  | "full_name"
  | "address"
  | "city"
  | "country"
  | "postal_code"
  | "url"
  | "uuid"
  | "ssn"
  | "credit_card"
  | "ip_address"
  | "company"
  | "product"
  | "currency";

export interface ForeignKey {
  entity: string;
  field: string;
}

export interface Field {
  name: string;
  type?: FieldType;
  items_type?: FieldType | null;
  nullable?: boolean;
  primary_key?: boolean;
  unique?: boolean;
  enum?: unknown[] | null;
  minimum?: number | null;
  maximum?: number | null;
  min_length?: number | null;
  max_length?: number | null;
  pattern?: string | null;
  semantic?: Semantic | null;
  role?: ColumnRole | null;
  pii?: boolean;
  references?: ForeignKey | null;
  description?: string | null;
  source_name?: string | null;
}

export interface Entity {
  name: string;
  fields: Field[];
  description?: string | null;
}

export interface Schema {
  name?: string;
  entities?: Entity[];
}

export interface SchemaIssue {
  path: string;
  message: string;
  severity?: "error" | "warning" | string;
}

export type SchemaFormat = "json_schema" | "xsd" | "natural_language";

export interface ParseSchemaRequest {
  format: SchemaFormat;
  content: string;
  /** Refine an existing schema with a follow-up instruction (natural language only). */
  current?: Schema | null;
}

export interface ParseSchemaResponse {
  schema: Schema;
  warnings: SchemaIssue[];
  json_schema: Record<string, unknown>;
}

export interface SchemaValidation {
  valid: boolean;
  issues: SchemaIssue[];
}

export type ExportFormat = "csv" | "json" | "jsonl" | "parquet" | "sql";

export interface GenerationOptions {
  /** Rows per root entity. */
  count?: number;
  /** Per-entity row counts. */
  counts?: Record<string, number>;
  seed?: number;
  children_per_parent?: [number, number] | number[];
  null_rate?: number;
}

export interface GenerateRequest {
  schema: Schema;
  options?: GenerationOptions;
  format?: ExportFormat;
  /** Store the result as a dataset instead of downloading it. */
  save_as?: string | null;
}

export interface GeneratePreview {
  planned_rows: Record<string, number>;
  entities: Record<string, Row[]>;
}

/** The three possible outcomes of `schemas.generate`. */
export type GenerateResult =
  | { kind: "file"; data: Blob; filename: string | undefined; contentType: string }
  | { kind: "dataset"; dataset: DatasetRecord }
  | { kind: "job"; job: Job };

// ---------------------------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------------------------

export type DataFormat = "csv" | "tsv" | "json" | "jsonl" | "parquet" | "xlsx";

export interface TableRecord {
  name: string;
  file: string;
  format: DataFormat;
  encoding?: string;
  size_bytes: number;
  sha256: string;
  original_filename?: string | null;
  row_count?: number | null;
}

export interface DatasetRecord {
  id: string;
  tenant_id: string;
  name: string;
  version: number;
  latest_version: number;
  parent_version: number | null;
  pipeline_id: string | null;
  source: string;
  created_at: Timestamp;
  created_by: string;
  tables: TableRecord[];
  schema: Schema | null;
  size_bytes: number;
}

export interface ColumnReport {
  source_name: string;
  name: string;
  type: FieldType;
  role: ColumnRole;
  semantic?: Semantic | null;
  pii?: boolean;
  nullable: boolean;
  null_fraction: number;
  distinct_count: number;
  unique: boolean;
  primary_key_candidate: boolean;
  detected_format?: string | null;
  ambiguous_formats?: string[] | null;
  parse_rate?: number | null;
}

export interface InferenceResult {
  schema: Schema;
  columns: ColumnReport[];
  sampled_rows: number;
  warnings: string[];
}

export interface UploadResponse {
  dataset: DatasetRecord;
  inference: InferenceResult | null;
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

export interface OutlierReport {
  iqr_count: number;
  iqr_bounds: [number, number] | number[];
  zscore_count: number;
}

export interface ColumnProfile {
  name: string;
  type?: FieldType | null;
  role?: ColumnRole | null;
  count: number;
  null_count: number;
  null_fraction: number;
  distinct_count: number;
  min?: unknown;
  max?: unknown;
  mean?: number | null;
  median?: number | null;
  std?: number | null;
  percentiles?: Record<string, number> | null;
  histogram?: Histogram | null;
  outliers?: OutlierReport | null;
  /** `[value, count]` pairs. */
  top_values?: [unknown, number][] | null;
  min_length?: number | null;
  max_length?: number | null;
  mean_length?: number | null;
  numeric_like_fraction?: number | null;
  date_like_fraction?: number | null;
  type_mismatch?: string | null;
}

export interface QualityScore {
  score: number;
  completeness: number;
  uniqueness: number;
  validity: number;
  consistency: number;
  formula?: string;
}

export interface DatasetProfile {
  row_count: number;
  column_count: number;
  duplicate_row_count: number;
  columns: ColumnProfile[];
  correlations: Record<string, Record<string, number | null>>;
  quality: QualityScore;
  warnings: string[];
}

export interface QueryRequest {
  /** SQL against the sandbox; the main table is called `data`. */
  sql: string;
  row_limit?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
}

export type SuggestionCategory = "descriptive" | "diagnostic" | "predictive" | "prescriptive";
export type SuggestionChartType = "bar" | "line" | "area" | "scatter" | "pie" | "heatmap" | "histogram" | "box" | "kpi" | "table";

export interface Suggestion {
  title: string;
  category: SuggestionCategory;
  chart_type: SuggestionChartType;
  x?: string | null;
  y?: string | null;
  aggregation?: string | null;
  group_by?: string[];
  rationale: string;
  sql: string;
  valid?: boolean;
  validation_error?: string | null;
  preview?: Row[] | null;
}

// ---------------------------------------------------------------------------------------------
// Cleaning pipelines
// ---------------------------------------------------------------------------------------------

interface StepBase {
  /** Free-text note shown in the pipeline history. */
  note?: string | null;
}

export interface DropMissingStep extends StepBase {
  op: "drop_missing";
  axis?: "rows" | "columns";
  columns?: string[] | null;
  how?: "any" | "all";
  max_null_fraction?: number;
}

export interface FillMissingStep extends StepBase {
  op: "fill_missing";
  columns?: string[] | null;
  strategy: "mean" | "median" | "mode" | "constant" | "ffill" | "bfill" | "interpolate";
  value?: unknown;
}

export interface HandleOutliersStep extends StepBase {
  op: "handle_outliers";
  columns?: string[] | null;
  method?: "iqr" | "zscore";
  threshold?: number;
  action?: "remove" | "cap" | "flag";
}

export interface DeduplicateStep extends StepBase {
  op: "deduplicate";
  columns?: string[] | null;
  keep?: "first" | "last";
}

export interface CastStep extends StepBase {
  op: "cast";
  column: string;
  to: "string" | "integer" | "number" | "boolean" | "date" | "datetime";
  format?: string | null;
  on_error?: "null" | "drop_row" | "fail";
}

export interface NormalizeStringsStep extends StepBase {
  op: "normalize_strings";
  columns?: string[] | null;
  trim?: boolean;
  case?: "lower" | "upper" | "title" | null;
  find?: string | null;
  replace?: string;
  collapse_whitespace?: boolean;
}

export interface NormalizeDatesStep extends StepBase {
  op: "normalize_dates";
  column: string;
  formats?: string[];
  output?: "date" | "datetime";
  dayfirst?: boolean;
}

export interface RenameStep extends StepBase {
  op: "rename";
  mapping: Record<string, string>;
}

export interface DropColumnsStep extends StepBase {
  op: "drop_columns";
  columns: string[];
}

export interface ReorderStep extends StepBase {
  op: "reorder";
  columns: string[];
}

export interface SplitStep extends StepBase {
  op: "split";
  column: string;
  separator: string;
  into: string[];
  drop_original?: boolean;
}

export interface MergeStep extends StepBase {
  op: "merge";
  columns: string[];
  into: string;
  separator?: string;
  drop_original?: boolean;
}

export interface DeriveStep extends StepBase {
  op: "derive";
  name: string;
  /** SQL expression. */
  expression: string;
}

export interface FilterStep extends StepBase {
  op: "filter";
  /** SQL condition; rows where it is true are kept. */
  condition: string;
}

export interface MaskPiiStep extends StepBase {
  op: "mask_pii";
  columns: string[];
  strategy?: "partial" | "hash" | "redact";
  semantics?: Record<string, Semantic>;
  salt?: string;
}

/** One cleaning operation, discriminated by `op`. */
export type Step =
  | DropMissingStep
  | FillMissingStep
  | HandleOutliersStep
  | DeduplicateStep
  | CastStep
  | NormalizeStringsStep
  | NormalizeDatesStep
  | RenameStep
  | DropColumnsStep
  | ReorderStep
  | SplitStep
  | MergeStep
  | DeriveStep
  | FilterStep
  | MaskPiiStep;

export type StepOp = Step["op"];

export interface Pipeline {
  id: string;
  name: string;
  dataset_id: string | null;
  is_template: boolean;
  steps: Step[];
  can_undo: boolean;
  can_redo: boolean;
  hash: string;
}

export interface PipelineCreate {
  dataset_id: string;
  name: string;
  steps?: Step[];
}

export interface PipelineFromTemplate {
  template_id: string;
  dataset_id: string;
  name?: string | null;
}

export interface StepStats {
  op: string;
  rows_before: number;
  rows_after: number;
  columns_before: number;
  columns_after: number;
  nulls_before: number;
  nulls_after: number;
  added_columns: string[];
  removed_columns: string[];
  changed_cells?: number | null;
}

export interface ColumnDelta {
  column: string;
  nulls_before: number | null;
  nulls_after: number | null;
  distinct_before: number | null;
  distinct_after: number | null;
  mean_before?: number | null;
  mean_after?: number | null;
}

export interface PipelinePreview {
  sample_rows: number;
  rows: Row[];
  columns: string[];
  step_stats: StepStats[];
  column_deltas: ColumnDelta[];
}

/** `result` of a finished `pipeline.apply` job. */
export interface PipelineApplyResult {
  dataset_id: string;
  version: number;
  parent_version: number | null;
  rows: number;
  step_stats: StepStats[];
}

// ---------------------------------------------------------------------------------------------
// Jobs and notifications
// ---------------------------------------------------------------------------------------------

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job<TResult = Record<string, unknown>> {
  id: string;
  /** e.g. `pipeline.apply`, `training.run`, `serving.batch_predict`, `data.generate`, `tenant.export`. */
  type: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message: string | null;
  params: Record<string, unknown>;
  result: TResult | null;
  error: string | null;
  attempts: number;
  created_by: string;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  read: boolean;
}

// ---------------------------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------------------------

export type ProblemType = "binary" | "multiclass" | "regression";

export interface HyperParameter {
  name: string;
  type: "int" | "float" | "categorical" | "bool";
  default: unknown;
  min?: number | null;
  max?: number | null;
  choices?: unknown[] | null;
  log?: boolean;
  help: string;
}

export interface Algorithm {
  id: string;
  name: string;
  family: string;
  problem_types: ProblemType[];
  supports_class_weight: boolean;
  hyperparameters: HyperParameter[];
}

export interface DetectRequest {
  dataset_id: string;
  target: string;
  version?: number | null;
}

export interface DetectResult {
  problem_type: ProblemType;
  reason: string;
  classes?: { value: string; count: number }[];
  imbalance_hint?: string;
}

export interface SplitConfig {
  method?: "random" | "stratified" | "time";
  test_size?: number;
  validation_size?: number;
  time_column?: string | null;
}

export interface CVConfig {
  method?: "kfold" | "stratified_kfold" | "timeseries";
  folds?: number;
}

export interface AutoMLConfig {
  enabled?: boolean;
  strategy?: "random" | "grid" | "tpe";
  n_trials?: number;
  timeout_seconds?: number;
}

export interface FeatureSelection {
  method?: "mutual_info" | "correlation" | "rfe" | "l1";
  k?: number;
}

export interface PreprocessingConfig {
  encoding?: "onehot" | "ordinal" | "target";
  scaling?: "standard" | "minmax" | "robust" | "log" | "none";
  impute?: "median" | "mean" | "most_frequent";
  feature_selection?: FeatureSelection | null;
  max_categories?: number;
}

export type ClassImbalance = "none" | "class_weight" | "smote" | "undersample" | "oversample";

export interface TrainingConfig {
  target: string;
  features?: string[] | null;
  problem_type?: ProblemType | null;
  split?: SplitConfig;
  cv?: CVConfig;
  /** Algorithm ids from `experiments.algorithms()`; all compatible ones when omitted. */
  algorithms?: string[] | null;
  automl?: AutoMLConfig;
  /** Fixed hyperparameters: `{algorithm_id: {param: value}}`. */
  hyperparameters?: Record<string, Record<string, unknown>>;
  preprocessing?: PreprocessingConfig;
  class_imbalance?: ClassImbalance;
  max_training_seconds?: number;
  seed?: number;
}

export interface ExperimentCreate extends TrainingConfig {
  name: string;
  dataset_id: string;
  dataset_version?: number | null;
}

export interface Experiment {
  id: string;
  name: string;
  dataset_id: string;
  dataset_version: number;
  config: TrainingConfig;
  created_by: string;
  created_at: Timestamp;
}

export interface RunArtifacts {
  leaderboard?: Record<string, unknown>[];
  confusion_matrix?: unknown;
  roc_curve?: { fpr: number[]; tpr: number[]; [key: string]: unknown };
  pr_curve?: { precision: number[]; recall: number[]; [key: string]: unknown };
  calibration?: { prob_pred: number[]; prob_true: number[] };
  residuals?: { predicted: number[]; residual: number[] };
  learning_curve?: { train_sizes: number[]; train_scores: number[]; val_scores: number[] };
  feature_importance?: { feature: string; importance: number }[];
  permutation_importance?: { feature: string; importance: number; std?: number }[];
  shap_summary?: { feature: string; mean_abs_shap: number }[];
  shap_base_value?: number;
  pdp?: Record<string, { grid: unknown[]; average: number[] }>;
  explanation_text?: string;
  warnings?: string[];
  [key: string]: unknown;
}

export interface Run {
  id: string;
  experiment_id: string;
  status: string;
  algorithm: string | null;
  params: Record<string, unknown>;
  metrics: Record<string, number | unknown>;
  artifacts: RunArtifacts;
  duration_seconds: number | null;
  created_at: Timestamp;
}

export interface ExperimentWithJob {
  experiment: Experiment;
  job: Job;
}

export interface ExperimentDetail {
  experiment: Experiment;
  runs: Run[];
  job: Job | null;
}

export interface RunComparison {
  metrics: string[];
  runs: {
    id: string;
    experiment_id: string;
    algorithm: string | null;
    params: Record<string, unknown>;
    metrics: Record<string, number | null>;
  }[];
}

export interface Explanation {
  predictions: unknown[];
  probabilities?: number[][];
  classes?: unknown[];
  /** Per-instance SHAP contribution of each source feature. */
  shap: Record<string, number>[];
  base_value: number | number[];
}

// ---------------------------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------------------------

export type ModelStage = "none" | "staging" | "production" | "archived";

export interface RegisterModelRequest {
  /** `[A-Za-z0-9][A-Za-z0-9_.-]*` */
  name: string;
  run_id: string;
  description?: string | null;
}

export interface RegisteredModelVersionRef {
  model_id: string;
  name: string;
  version: number;
  model_version_id: string;
  stage: ModelStage;
}

export interface ModelSummary {
  id: string;
  name: string;
  description: string | null;
  latest_version: number | null;
  production_version: number | null;
}

export interface ModelVersion {
  id: string;
  version: number;
  stage: ModelStage;
  run_id: string;
  metrics: Record<string, unknown>;
  algorithm: string | null;
  signature: {
    target?: string;
    problem_type?: ProblemType;
    classes?: unknown[];
    features?: Record<string, unknown>[];
  };
  created_at: Timestamp;
}

export interface ModelDetail {
  model: { id: string; name: string; description: string | null; created_at: Timestamp };
  versions: ModelVersion[];
}

// ---------------------------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------------------------

export interface Route {
  model_version_id: string;
  /** Relative traffic weight for A/B splits. */
  weight: number;
}

export interface EndpointCreate {
  /** URL-safe endpoint name. */
  name: string;
  model_id?: string | null;
  /** Model version; the production version when omitted. */
  version?: number | null;
  routes?: Route[] | null;
  min_replicas?: number;
  log_payloads?: boolean;
  cors_origins?: string[];
}

export interface EndpointPatch {
  routes?: Route[] | null;
  min_replicas?: number | null;
  log_payloads?: boolean | null;
  cors_origins?: string[] | null;
  /** e.g. `active` or `paused`. */
  status?: string | null;
}

export interface EndpointRoute {
  model_version_id: string;
  weight: number;
  model_id?: string;
  version?: number;
  run_id?: string;
  [key: string]: unknown;
}

export interface Endpoint {
  id: string;
  name: string;
  routes: EndpointRoute[];
  status: string;
  min_replicas: number;
  log_payloads: boolean;
  cors_origins: string[];
  created_at: Timestamp;
  url: string;
}

export interface PredictOptions {
  /** Also return per-instance SHAP contributions. */
  explain?: boolean;
}

export interface PredictResponse<TPrediction = unknown> {
  predictions: TPrediction[];
  probabilities?: number[][];
  classes?: unknown[];
  model_version: { model_id: string; version: number };
  /** Present when `explain: true`. */
  shap?: Record<string, number>[];
  base_value?: number | number[];
}

export interface LatencySummary {
  requests: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface EndpointMetrics extends LatencySummary {
  window_hours: number;
  by_version: Record<string, LatencySummary>;
}

// ---------------------------------------------------------------------------------------------
// Saved analytics
// ---------------------------------------------------------------------------------------------

export interface ChartSpec {
  type?: string;
  x?: string | null;
  y?: string | null;
  series?: string | null;
  aggregation?: string | null;
}

export interface AnalyticParameter {
  name: string;
  type?: "string" | "number" | "date";
  default?: unknown;
}

export interface AnalyticCreate {
  dataset_id: string;
  name: string;
  /** Parameters are referenced as `:name`. */
  sql: string;
  chart?: ChartSpec;
  parameters?: AnalyticParameter[];
}

export interface Analytic extends Required<Pick<AnalyticCreate, "dataset_id" | "name" | "sql">> {
  id: string;
  chart: ChartSpec;
  parameters: AnalyticParameter[];
  created_by: string;
  created_at: Timestamp;
}

export interface RunAnalyticRequest {
  params?: Record<string, unknown>;
  filters?: Filters;
  row_limit?: number;
}

// ---------------------------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------------------------

export type WidgetType = "chart" | "kpi" | "table" | "text" | "filter" | "image" | "prediction" | "alert" | "iframe";
export type DashboardChartType =
  | "bar"
  | "line"
  | "area"
  | "scatter"
  | "pie"
  | "heatmap"
  | "histogram"
  | "box"
  | "treemap"
  | "funnel"
  | "gauge"
  | "sankey"
  | "waterfall";
export type Aggregation = "sum" | "avg" | "count" | "min" | "max";
export type FilterKind = "dropdown" | "multiselect" | "slider" | "date";

/** A filter value: exact match, one of a list, or a range. */
export type FilterValue = unknown | unknown[] | { min?: unknown; max?: unknown };
export type Filters = Record<string, FilterValue>;

export interface WidgetLayout {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface Threshold {
  op: ">" | ">=" | "<" | "<=" | "==" | "!=" | string;
  value: number;
  color: string;
}

export interface WidgetConfig {
  analytic_id?: string;
  dataset_id?: string;
  sql?: string;
  chart?: { type: DashboardChartType | string; x?: string; y?: string; series?: string; aggregation?: Aggregation | string };
  kpi?: { value: string; target?: number; trend?: string };
  text?: string;
  image_url?: string;
  filter?: { column: string; kind: FilterKind; dataset_id: string };
  endpoint?: string;
  thresholds?: Threshold[];
  conditional_format?: (Threshold & { column: string })[];
  [key: string]: unknown;
}

export interface Widget {
  id?: string;
  type: WidgetType;
  title?: string;
  layout?: WidgetLayout;
  config?: WidgetConfig;
}

export interface DashboardPage {
  id?: string;
  title?: string;
  widgets?: Widget[];
}

export interface GlobalFilter {
  id: string;
  column: string;
  kind?: FilterKind;
  default?: unknown;
}

export interface DashboardSpec {
  pages?: DashboardPage[];
  filters?: GlobalFilter[];
  date_range?: { column: string; default?: string; [key: string]: unknown } | null;
  theme?: { mode?: "light" | "dark"; primary?: string; [key: string]: unknown };
  refresh_seconds?: number | null;
}

export interface Dashboard {
  id: string;
  name: string;
  spec: DashboardSpec;
  owner_id: string;
  /** user id (or `*`) → `editor` | `viewer` */
  shares: Record<string, string>;
  archived: boolean;
  your_role: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DashboardCreate {
  name: string;
  spec?: DashboardSpec;
}

export interface DashboardUpdate {
  name?: string | null;
  spec?: DashboardSpec | null;
}

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
}

export interface DashboardFromTemplate {
  template: string;
  name: string;
  /** Placeholders, e.g. `dataset_id`, `measure`, `dimension`. */
  values?: Record<string, string>;
}

export interface WidgetData {
  columns?: string[];
  rows?: unknown[][] | Row[];
  [key: string]: unknown;
}

export interface EmbedToken {
  token: string;
  expires_in_minutes: number;
  embed_path: string;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export type WebhookEvent = "job.succeeded" | "job.failed" | "model.registered" | "endpoint.threshold" | (string & {});

export interface WebhookCreate {
  /** HTTPS URL on a public host. */
  url: string;
  events: WebhookEvent[];
}

export interface WebhookWithSecret {
  id: string;
  url: string;
  events: WebhookEvent[];
  /** HMAC signing secret, shown only once. */
  secret: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  created_at: Timestamp;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  response_code: number | null;
  created_at: Timestamp;
  delivered_at: Timestamp | null;
}

// ---------------------------------------------------------------------------------------------
// OAuth 2.0 client credentials (MGT-004a)
// ---------------------------------------------------------------------------------------------

export interface ClientCredentialsToken {
  access_token: string;
  token_type: string;
  /** Lifetime in seconds (900 by default). */
  expires_in: number;
  scope?: string;
}

export interface OAuthClientCreate {
  name: string;
  role?: Role;
  /** Optional narrowing of the role's permissions. */
  scopes?: Permission[] | string[];
}

export interface OAuthClient {
  id: string;
  client_id: string;
  name: string;
  role: Role | string;
  scopes: string[];
  created_at?: Timestamp;
  [key: string]: unknown;
}

export interface OAuthClientWithSecret extends OAuthClient {
  /** Shown once. */
  client_secret: string;
  token_url: string;
}

// ---------------------------------------------------------------------------------------------
// Projects and teams (AUTH-004)
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  open: boolean;
  members?: string[];
  teams?: string[];
  created_at?: Timestamp;
  [key: string]: unknown;
}

export interface ProjectCreate {
  name: string;
  open?: boolean;
  members?: string[];
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  members?: string[];
  created_at?: Timestamp;
  [key: string]: unknown;
}

export interface TeamCreate {
  name: string;
  description?: string | null;
  members?: string[];
}

// ---------------------------------------------------------------------------------------------
// Schedules (Phase 3)
// ---------------------------------------------------------------------------------------------

export type ScheduleJobType =
  | "analytics.scheduled_run"
  | "dashboard.deliver"
  | "serving.drift_check"
  | "stream.compact"
  | "dataset.profile"
  | "pipeline.apply"
  | (string & {});

export interface ScheduleType {
  job_type: ScheduleJobType;
  permission: string;
  description: string;
  /** Whether the caller holds the permission. */
  allowed: boolean;
}

export interface ScheduleCreate {
  name: string;
  /** 5-field cron expression, e.g. `0 6 * * mon-fri`. */
  cron: string;
  /** IANA time zone (default `UTC`). */
  timezone?: string;
  job_type: ScheduleJobType;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ScheduleUpdate {
  name?: string;
  cron?: string;
  timezone?: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  job_type: ScheduleJobType;
  params: Record<string, unknown>;
  enabled: boolean;
  next_run_at: Timestamp | null;
  last_run_at: Timestamp | null;
  last_job_id: string | null;
  last_status: string | null;
  last_error: string | null;
  last_result: Record<string, unknown> | null;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** The next five run times. */
  upcoming: Timestamp[];
}

export interface ScheduleRun {
  schedule_id: string;
  status: "submitted";
  job_id: string;
}

// ---------------------------------------------------------------------------------------------
// Connectors (ING-007)
// ---------------------------------------------------------------------------------------------

export type ConnectorKind = "s3" | "gcs" | "postgresql" | "mysql" | (string & {});

export interface ConnectorCreate {
  name: string;
  kind: ConnectorKind;
  /** s3/gcs `{bucket, region?, project?, endpoint_url?}`; databases `{host, port?, database, sslmode?}`. */
  config: Record<string, unknown>;
  /** Written to the secret store and never returned. */
  credentials?: Record<string, unknown>;
}

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  config: Record<string, unknown>;
  created_by: string;
  created_at: Timestamp;
}

export interface ConnectorImport {
  project_id?: string;
  name?: string;
  /** One object (object storage). */
  key?: string;
  /** Up to 100 objects, one table each (object storage). */
  prefix?: string;
  /** A single SELECT (databases). */
  query?: string;
  row_limit?: number;
}

export interface ConnectorImportResult {
  dataset_id: string;
  version: number;
  tables: { name: string; row_count: number; size_bytes: number }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Streams (ING-008)
// ---------------------------------------------------------------------------------------------

export interface StreamCreate {
  name: string;
  project_id?: string | null;
  columns?: Record<string, unknown>[];
  compact_rows?: number | null;
  compact_bytes?: number | null;
}

export type StreamRecord = Record<string, string | number | boolean | null>;

export interface StreamAppendResult {
  dataset_id: string;
  accepted: number;
  buffered_rows: number;
  buffered_bytes: number;
  compaction_job_id?: string | null;
}

export interface StreamStatus {
  dataset_id: string;
  name: string;
  version: number;
  stored_bytes: number;
  stored_rows: number;
  buffered_rows: number;
  buffered_bytes: number;
  buffered_batches: number;
  compact_rows: number;
  compact_bytes: number;
  max_dataset_bytes: number;
  compacting_job_id: string | null;
  last_compacted_at: Timestamp | null;
}

// ---------------------------------------------------------------------------------------------
// Comments (SHR-005)
// ---------------------------------------------------------------------------------------------

export interface Comment {
  id: string;
  dashboard_id: string;
  widget_id: string | null;
  parent_id: string | null;
  author_id: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  created_at: Timestamp;
  edited_at: Timestamp | null;
  replies?: Comment[];
}

export interface CommentCreate {
  /** 1-5000 characters; `@<user_id>` mentions notify the user. */
  body: string;
  widget_id?: string | null;
  parent_id?: string | null;
}

export interface CommentUpdate {
  body?: string;
  resolved?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Multi-dataset analytics and suggestion feedback (LLM-008, LLM-009)
// ---------------------------------------------------------------------------------------------

/** `{alias: dataset_id}`; aliases match `^[a-z_][a-z0-9_]{0,39}$`. */
export type DatasetAliases = Record<string, string>;

export interface JoinCandidate {
  left_table: string;
  left_column: string;
  right_table: string;
  right_column: string;
  /** Share of distinct left values found on the right. */
  containment: number;
}

export interface MultiDatasetSuggestions {
  suggestions: Suggestion[];
  join_candidates: JoinCandidate[];
}

export interface SuggestionFeedback {
  accepted: boolean;
  suggestion: { chart_type: SuggestionChartType | string; category: SuggestionCategory | string; title?: string };
}

export interface SuggestionPreferences {
  preferences: Record<string, Record<string, { accepted: number; rejected: number }>>;
  summary: string | null;
}

// ---------------------------------------------------------------------------------------------
// Schema history (SCH-010)
// ---------------------------------------------------------------------------------------------

export interface SchemaDiff {
  identical: boolean;
  added_entities: string[];
  removed_entities: string[];
  entities: {
    name: string;
    added_fields: { name: string; type: string; nullable: boolean }[];
    removed_fields: { name: string; type: string; nullable: boolean }[];
    retyped_fields: { field: string; from_type: string; to_type: string }[];
    changed_fields: { field: string; attribute: string; from: unknown; to: unknown }[];
  }[];
  breaking: boolean;
  summary: string[];
}

export interface SavedSchema {
  id: string;
  project_id: string | null;
  name: string;
  current_version: number;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  versions?: SavedSchemaVersion[];
}

export interface SavedSchemaVersion {
  version: number;
  message?: string | null;
  source_format?: string | null;
  created_by?: string;
  created_at?: Timestamp;
  schema?: Schema;
  [key: string]: unknown;
}

export interface SaveSchemaRequest {
  name: string;
  schema: Schema;
  project_id?: string | null;
  message?: string | null;
  source_format?: string | null;
}

export interface SaveSchemaResponse {
  schema_record: SavedSchema;
  version: SavedSchemaVersion;
  /** False when the content is identical to the latest version. */
  created: boolean;
  diff?: SchemaDiff | null;
}

// ---------------------------------------------------------------------------------------------
// Dataset versions, annotations, advanced profiling, projections
// ---------------------------------------------------------------------------------------------

export type VersionMode = "append" | "replace";

export interface DatasetEvolution {
  dataset: DatasetRecord;
  previous_version: number;
  mode: VersionMode;
  inference: InferenceResult;
  diff: SchemaDiff;
}

export type ColumnAnnotation = "pii" | "sensitive" | "derived" | "target" | "id";

export interface DatasetAnnotations {
  dataset_id: string;
  version: number;
  /** `{entity: {field: [annotation]}}` */
  annotations: Record<string, Record<string, ColumnAnnotation[]>>;
}

export interface AnnotationsUpdate {
  columns: Record<string, ColumnAnnotation[]>;
  entity?: string | null;
  version?: number | null;
  replace?: boolean;
}

export interface AdvancedProfileRequest {
  isolation_forest?: { enabled?: boolean; contamination?: "auto" | number; n_estimators?: number; max_rows?: number; columns?: string[]; seed?: number };
  near_duplicates?: { enabled?: boolean; columns?: string[]; threshold?: number; window?: number; max_rows?: number };
  missing_patterns?: { enabled?: boolean; alpha?: number; max_rows?: number; max_columns?: number };
}

export interface AdvancedProfile {
  row_count: number;
  isolation_forest?: Record<string, unknown> | null;
  near_duplicates?: Record<string, unknown> | null;
  missing_patterns?: Record<string, unknown> | null;
}

export interface ProjectionRequest {
  method?: "auto" | "umap" | "tsne" | "pca";
  features?: string[];
  color_by?: string;
  /** 10-5000 (default 2000). */
  sample?: number;
  perplexity?: number;
  n_neighbors?: number;
  seed?: number;
}

export interface Projection {
  method: string;
  n: number;
  total_rows: number;
  x: number[];
  y: number[];
  color_by?: string | null;
  color?: unknown[] | null;
  features?: string[] | null;
  actual?: unknown[] | null;
  note?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Training templates, fairness, custom model upload
// ---------------------------------------------------------------------------------------------

export interface TrainingTemplate {
  id: string;
  name: string;
  description: string | null;
  config: Partial<TrainingConfig> & Record<string, unknown>;
  created_by: string;
  created_at: Timestamp;
}

export interface TrainingTemplateCreate {
  name: string;
  description?: string | null;
  config: Partial<TrainingConfig> & Record<string, unknown>;
}

export interface TrainingTemplateApply {
  name: string;
  dataset_id: string;
  dataset_version?: number | null;
  /** Deep-merged over the template, e.g. `{target: "churn"}`. */
  overrides?: Record<string, unknown>;
}

export interface FairnessRequest {
  /** 1-20 columns. */
  protected: string[];
  positive_class?: unknown;
  min_group_size?: number;
}

export interface FairnessGroup {
  group: string;
  n: number;
  selection_rate: number | null;
  base_rate: number | null;
  tpr: number | null;
  fpr: number | null;
  precision: number | null;
  accuracy: number | null;
  selection_ratio: number | null;
  small_group: boolean;
}

export interface FairnessReport {
  run_id: string;
  positive_class: unknown;
  n_test: number;
  min_group_size: number;
  attributes: {
    attribute: string;
    grouping: "categories" | "quartiles";
    groups: FairnessGroup[];
    demographic_parity_difference: number | null;
    demographic_parity_ratio: number | null;
    equalized_odds_difference: number | null;
    four_fifths_rule: { threshold: number; passed: boolean; flagged_groups: string[] };
  }[];
}

export interface ModelSignatureUpload {
  problem_type: "binary" | "multiclass" | "regression";
  target?: string;
  classes?: unknown[];
  features: { name: string; type: "number" | "integer" | "string" | "boolean"; categories?: unknown[]; min?: number; max?: number }[];
  input?: "auto" | "per_feature" | "tensor";
  outputs?: { label?: string; probabilities?: string; value?: string };
}

export interface ModelUploadResult {
  model_id: string;
  name: string;
  version: number;
  model_version_id: string;
  stage: ModelStage;
  run_id: string;
  sha256: string;
  input_mode: string;
  reference_dataset_id: string | null;
}

// ---------------------------------------------------------------------------------------------
// Serving: anomaly/forecast shapes, streaming, canary, drift
// ---------------------------------------------------------------------------------------------

export interface AnomalyPrediction {
  is_anomaly: boolean;
  score: number;
}

export interface AnomalyResponse extends PredictResponse<AnomalyPrediction> {
  threshold: number;
}

export interface ForecastRequest {
  /** 1-1000 (default: the trained horizon). */
  horizon?: number;
  /** Recent observations `{<time_column>|timestamp, <target>|value}`; the model is refit with them. */
  history?: Row[];
}

export interface ForecastResponse {
  horizon: number;
  timestamps: string[];
  predictions: number[];
  lower: number[];
  upper: number[];
  interval_level: number;
  model_version: { model_id: string; version: number };
}

export interface StreamPredictRequest extends ForecastRequest {
  instances?: Row[];
  explain?: boolean;
  /** 1-1000 (default 100). */
  chunk_size?: number;
}

/** Events of `POST /v1/endpoints/{name}/predict/stream`. */
export type PredictStreamEvent =
  | { event: "start"; data: { endpoint: string; total?: number; chunk_size?: number; horizon?: number; model_version?: unknown } }
  | { event: "prediction"; data: PredictResponse & { offset: number; count: number } }
  | { event: "forecast"; data: { step: number; timestamp: string; prediction: number; lower: number; upper: number } }
  | { event: "done"; data: { total?: number; steps?: number; interval_level?: number } };

export interface StreamToken {
  token: string;
  expires_in: number;
  /** Path with the token, e.g. `/v1/endpoints/churn/ws?token=…`. */
  url: string;
}

export interface CanaryStart {
  model_version_id: string;
  /** Traffic percentages; a final 100 is appended when missing (default [5, 25, 50, 100]). */
  steps?: number[];
  step_minutes?: number;
  max_error_rate?: number;
  max_p95_ms_increase?: number;
  min_requests?: number;
}

export type CanaryStatus = "running" | "completed" | "rolled_back" | "aborted";

export interface CanaryRollout {
  id: string;
  endpoint: string;
  status: CanaryStatus;
  candidate: EndpointRoute;
  baseline_routes: EndpointRoute[];
  steps: number[];
  step_index: number;
  weight: number;
  thresholds: { max_error_rate: number; max_p95_ms_increase: number; min_requests: number };
  reason: string | null;
  history: Record<string, unknown>[];
  step_started_at: Timestamp | null;
  next_eval_at: Timestamp | null;
  live?: { canary: Record<string, unknown>; baseline: Record<string, unknown> };
}

export type DriftStatus = "ok" | "warn" | "alert" | "insufficient_data" | "no_data" | "not_applicable";

export interface DriftReport {
  endpoint: string;
  window_hours: number;
  thresholds: { warn: number; alert: number };
  min_samples: number;
  samples: number;
  status: DriftStatus;
  model_version: unknown;
  features: { feature: string; type: string; psi: number | null; status: DriftStatus; bins: unknown[]; expected: number[]; actual: number[]; samples: number }[];
  prediction: { psi: number | null; status: DriftStatus; bins: unknown[]; expected: number[]; actual: number[] } | null;
  by_version: Record<string, unknown>;
}

export interface NotificationPreferences {
  /** Kinds emailed to the user, e.g. `job.failed`, `endpoint.threshold`, or `*`. */
  email: string[];
}

// ---------------------------------------------------------------------------------------------
// Resumable uploads (ING-NFR-001) and retention (SOC-PRV-002)
// ---------------------------------------------------------------------------------------------

export interface UploadSession {
  id: string;
  filename: string;
  /** Total bytes declared. */
  size: number;
  /** Bytes received so far; the next part starts here. */
  offset: number;
  status: "open" | "completing" | "completed" | "aborted" | (string & {});
  part_max_bytes: number;
  expires_at: Timestamp;
  dataset_id?: string | null;
}

export interface RetentionPolicy {
  llm_bodies_days: number;
  llm_metadata_days: number;
  /** At least 365. */
  audit_days: number;
  inference_logs_days: number;
}

export interface RetentionApplyResult {
  llm_bodies_redacted: number;
  usage_rows_deleted: number;
  prediction_logs_deleted: number;
  audit_entries_deleted: number;
  [key: string]: unknown;
}
