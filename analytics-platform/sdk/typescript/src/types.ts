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
