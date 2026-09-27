/**
 * Types mirroring docs/API_CONTRACT.md (v1) and the FastAPI models in backend/app/api/*.py.
 * Where the contract leaves a shape open (e.g. experiments, models) fields are optional.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Row = Record<string, unknown>;

// -- Auth ----------------------------------------------------------------------

export type Role = "admin" | "data_engineer" | "data_scientist" | "analyst" | "viewer";
export const ROLES: Role[] = ["admin", "data_engineer", "data_scientist", "analyst", "viewer"];

export type AuthErrorCode =
  | "invalid_credentials"
  | "locked"
  | "mfa_required"
  | "mfa_invalid"
  | "mfa_enrollment_required"
  | "disabled";

export interface SignupRequest {
  tenant_id: string;
  org_name: string;
  email: string;
  password: string;
  name?: string;
  region: "us" | "eu";
}

export interface LoginRequest {
  email: string;
  password: string;
  totp?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface Me {
  tenant_id: string;
  id: string;
  role: Role;
  method: "jwt" | "api_key" | string;
  email?: string;
  name?: string | null;
  mfa_enabled?: boolean;
}

// -- Tenant admin ----------------------------------------------------------------

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
  cloud_provider?: string;
}

export interface TenantUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  mfa_enabled: boolean;
  disabled: boolean;
}

export type PermissionName =
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

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  scopes: string[];
  rate_limit_per_minute: number;
  allowed_ips: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyCreate {
  name: string;
  role: Role;
  scopes: PermissionName[];
  rate_limit_per_minute: number;
  expires_in_days?: number;
  allowed_ips: string[];
}

export type ApiKeyWithSecret = ApiKey & { key: string };

export type ProviderKind = "platform" | "openai" | "openai_compatible" | "anthropic" | "gemini" | "mock";
export type DataMinimization = "L0" | "L1" | "L2" | "L3";

export interface ProviderConfig {
  kind: ProviderKind;
  model?: string | null;
  base_url?: string | null;
  secret_name?: string | null;
}

export interface LLMConfig {
  chain: ProviderConfig[];
  /** per-task model for the primary provider, e.g. {"analytics.suggest": "claude-sonnet-5"} */
  task_models?: Record<string, string>;
  data_minimization: DataMinimization;
  cache_enabled: boolean;
}

export interface LLMUsageEntry {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  calls?: number;
  [key: string]: unknown;
}

export interface LLMUsage {
  by_model: Record<string, LLMUsageEntry>;
  total_cost_usd: number;
  total_tokens: number;
}

export interface Usage {
  storage_bytes: number;
  /** metric → {dimension (endpoint, job type, model…) → amount} */
  counters: Record<string, Record<string, number> | number>;
}

export interface AuditEntry {
  seq: number;
  at: string;
  tenant_id: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface Project {
  id: string;
  name: string;
  /** open projects are visible to everyone in the organization */
  open: boolean;
  members: string[];
  created_at?: string;
}

export interface SSOSettings {
  domains: string[];
  default_role: Role;
}

// -- Schemas -------------------------------------------------------------------

export type FieldType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "array";
export const FIELD_TYPES: FieldType[] = ["string", "integer", "number", "boolean", "date", "datetime", "array"];

export type ColumnRole = "identifier" | "categorical" | "continuous" | "datetime" | "text" | "boolean";

export const SEMANTICS = [
  "email",
  "phone",
  "first_name",
  "last_name",
  "full_name",
  "address",
  "city",
  "country",
  "postal_code",
  "url",
  "uuid",
  "ssn",
  "credit_card",
  "ip_address",
  "company",
  "product",
  "currency",
] as const;
export type Semantic = (typeof SEMANTICS)[number];
export const PII_SEMANTICS: ReadonlySet<string> = new Set([
  "email",
  "phone",
  "first_name",
  "last_name",
  "full_name",
  "address",
  "postal_code",
  "ssn",
  "credit_card",
  "ip_address",
]);

export interface SchemaField {
  name: string;
  type: FieldType;
  items_type?: FieldType | null;
  nullable: boolean;
  primary_key: boolean;
  unique: boolean;
  enum?: JsonValue[] | null;
  minimum?: number | null;
  maximum?: number | null;
  min_length?: number | null;
  max_length?: number | null;
  pattern?: string | null;
  semantic?: Semantic | null;
  role?: ColumnRole | null;
  pii: boolean;
  references?: { entity: string; field: string } | null;
  description?: string | null;
  source_name?: string | null;
  /** ANA-010 column annotations */
  annotations?: ColumnAnnotation[];
}

export interface Entity {
  name: string;
  fields: SchemaField[];
  description?: string | null;
}

export interface Schema {
  name: string;
  entities: Entity[];
}

export interface SchemaIssue {
  severity?: "error" | "warning" | string;
  path?: string;
  message: string;
  [key: string]: unknown;
}

export type SchemaFormat = "json_schema" | "xsd" | "natural_language" | "sql_ddl";

export interface ParseResponse {
  schema: Schema;
  warnings: SchemaIssue[];
  json_schema: Record<string, unknown>;
}

export interface GenerationOptions {
  count: number;
  counts?: Record<string, number>;
  seed: number;
  children_per_parent?: [number, number];
  null_rate: number;
  /** GEN-006: {"entity.field": Distribution} */
  distributions?: Record<string, Distribution>;
  /** GEN-009: 0–0.5 */
  anomaly_rate?: number;
}

export type DistributionKind = "uniform" | "normal" | "lognormal" | "weights";

export interface Distribution {
  kind: DistributionKind;
  mean?: number | null;
  std?: number | null;
  sigma?: number | null;
  weights?: Record<string, number> | null;
}

export type ExportFormat = "csv" | "json" | "jsonl" | "parquet" | "sql" | "xml";

export interface GeneratePreview {
  planned_rows: Record<string, number>;
  entities: Record<string, Row[]>;
}

// -- Datasets --------------------------------------------------------------------

export interface TableRecord {
  name: string;
  file: string;
  format: string;
  size_bytes: number;
  sha256: string;
  row_count?: number | null;
  encoding?: string | null;
  original_filename?: string | null;
  /** ING-003a / ING-006 / CLN-009: set when the stored table was converted, extracted or transcoded */
  source_format?: string | null;
  source_encoding?: string | null;
  raw_file?: string | null;
  notes?: string[];
}

export interface DatasetRecord {
  id: string;
  tenant_id: string;
  project_id?: string | null;
  name: string;
  version: number;
  latest_version: number;
  parent_version: number | null;
  pipeline_id: string | null;
  source: string;
  created_at: string;
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
  pii: boolean;
  nullable: boolean;
  null_fraction: number;
  distinct_count: number;
  unique: boolean;
  primary_key_candidate: boolean;
  detected_format?: string | null;
  ambiguous_formats?: string[] | null;
  parse_rate?: number | null;
}

export interface Relationship {
  child_entity: string;
  child_field: string;
  parent_entity: string;
  parent_field: string;
  name_score: number;
  containment: number;
}

export interface InferenceResult {
  schema: Schema;
  columns: (ColumnReport & { table?: string | null })[];
  sampled_rows: number;
  warnings: string[];
  relationships?: Relationship[];
}

export interface UploadResponse {
  dataset: DatasetRecord;
  inference: InferenceResult | null;
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
  histogram?: { edges: number[]; counts: number[] } | null;
  outliers?: { iqr_count: number; iqr_bounds: [number, number]; zscore_count: number } | null;
  top_values?: [string, number][] | null;
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
  formula: string;
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

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
}

export type SuggestionCategory = "descriptive" | "diagnostic" | "predictive" | "prescriptive";

export interface Suggestion {
  title: string;
  category: SuggestionCategory;
  chart_type: string;
  x: string | null;
  y: string | null;
  aggregation: string | null;
  group_by: string[];
  rationale: string;
  sql: string;
  valid: boolean;
  validation_error: string | null;
  preview: Row[] | null;
}

// -- Pipelines -------------------------------------------------------------------

export type StepOp =
  | "drop_missing"
  | "fill_missing"
  | "handle_outliers"
  | "deduplicate"
  | "fuzzy_deduplicate"
  | "cast"
  | "normalize_strings"
  | "normalize_dates"
  | "rename"
  | "drop_columns"
  | "reorder"
  | "split"
  | "merge"
  | "derive"
  | "filter"
  | "mask_pii";

export interface PipelineStep {
  op: StepOp;
  note?: string | null;
  [key: string]: unknown;
}

export interface Pipeline {
  id: string;
  name: string;
  dataset_id: string | null;
  is_template: boolean;
  steps: PipelineStep[];
  can_undo: boolean;
  can_redo: boolean;
  hash: string;
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

// -- Jobs & notifications ------------------------------------------------------------

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  created_by?: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  read: boolean;
}

// -- Training -------------------------------------------------------------------

export type SupervisedProblemType = "binary" | "multiclass" | "regression";
export type ProblemType = SupervisedProblemType | "clustering" | "forecasting";

export interface Hyperparameter {
  name: string;
  type: "int" | "float" | "bool" | "categorical" | "str" | string;
  default: JsonValue;
  min?: number | null;
  max?: number | null;
  choices?: JsonValue[] | null;
  log?: boolean | null;
  help: string;
}

export interface Algorithm {
  id: string;
  name: string;
  family: string;
  problem_types: ProblemType[];
  hyperparameters: Hyperparameter[];
}

export interface DetectResponse {
  problem_type: ProblemType;
  reason?: string;
  /** MDL-002a: a numeric target on a regular date index can also be forecast */
  alternatives?: { problem_type: ProblemType; time_column?: string; frequency?: string; reason?: string }[];
  /** backend returns [{value, count}] (top 100 classes) */
  classes?: ({ value: string; count: number } | JsonValue)[] | null;
  imbalance_hint?: string;
}

export interface ExperimentCreate {
  name: string;
  dataset_id: string;
  dataset_version?: number;
  /** optional only for clustering */
  target?: string;
  features?: string[];
  problem_type?: ProblemType;
  split: { method: "random" | "stratified" | "time"; test_size: number; validation_size: number; time_column?: string };
  cv: { method: "kfold" | "stratified_kfold" | "timeseries"; folds: number };
  algorithms?: string[];
  automl: { enabled: boolean; strategy: "random" | "grid" | "tpe"; n_trials: number; timeout_seconds: number };
  hyperparameters?: Record<string, Record<string, JsonValue>>;
  preprocessing: {
    encoding: "onehot" | "ordinal" | "target";
    scaling: "standard" | "minmax" | "robust" | "log" | "none";
    impute: "median" | "mean" | "most_frequent";
    feature_selection?: { method: "mutual_info" | "correlation" | "rfe" | "l1"; k: number };
    /** FE-001 */
    auto_features?: { interactions: boolean; polynomial: boolean; top_k: number } | null;
    /** FE-005: < 1 = share of variance kept, >= 1 = number of components */
    pca?: { n_components: number } | null;
  };
  class_imbalance: "none" | "class_weight" | "smote" | "undersample" | "oversample";
  max_training_seconds: number;
  seed: number;
  /** TRN-005; enabled null = on when AutoML picked the algorithms */
  ensemble?: { enabled: boolean | null; methods: ("stacking" | "voting")[]; top_k: number };
  /** TRN-006 */
  clustering?: { k_min: number; k_max: number; max_fit_rows?: number } | null;
  /** TRN-007 */
  forecast?: ForecastConfig | null;
}

export interface ForecastConfig {
  time_column: string;
  /** pandas offset alias (D, W-SUN, MS, h …); empty = detect */
  frequency?: string | null;
  horizon: number;
  season_length?: number | null;
  backtest_folds: number;
  interval_level: number;
  aggregation: "mean" | "sum" | "last";
}

/** A TrainingConfig: the experiment body without name / dataset. */
export type TrainingConfig = Partial<Omit<ExperimentCreate, "name" | "dataset_id" | "dataset_version">>;

export interface TrainingTemplate {
  id: string;
  name: string;
  description: string | null;
  config: TrainingConfig;
  created_by: string;
  created_at: string;
  updated_at?: string;
}

export interface Experiment {
  id: string;
  name: string;
  dataset_id: string;
  dataset_version?: number | null;
  /** The training configuration (target, features, problem_type, split, …) */
  config: Partial<Omit<ExperimentCreate, "name" | "dataset_id" | "dataset_version">> & Record<string, unknown>;
  created_at?: string;
  created_by?: string;
}

export interface LeaderboardEntry {
  algorithm?: string;
  params?: Record<string, unknown>;
  score?: number;
  metrics?: Record<string, number>;
  [key: string]: unknown;
}

export interface RunArtifacts {
  leaderboard?: LeaderboardEntry[];
  confusion_matrix?: number[][] | { labels?: JsonValue[]; matrix: number[][] };
  roc_curve?: { fpr: number[]; tpr: number[]; auc?: number };
  pr_curve?: { precision: number[]; recall: number[]; auc?: number };
  calibration?: { prob_pred: number[]; prob_true: number[] };
  residuals?: { predicted: number[]; residual: number[] };
  learning_curve?: { train_sizes: number[]; train_scores: number[]; val_scores: number[] };
  feature_importance?: { feature: string; importance: number }[];
  permutation_importance?: { feature: string; importance: number; std?: number }[];
  shap_summary?: { feature: string; mean_abs_shap: number }[];
  pdp?: Record<string, { grid: number[]; average: number[] }>;
  shap_beeswarm?: Record<string, { shap: number[]; value: JsonValue[] }>;
  shap_base_value?: number | number[];
  explanation_text?: string | null;
  classes?: JsonValue[];
  /** XAI-001a accumulated local effects */
  ale?: Record<string, { grid: number[]; ale: number[]; counts?: number[] }>;
  /** TRN-005 */
  ensemble_members?: { algorithm: string; params?: Record<string, unknown> }[];
  // EXP-005 clustering
  cluster_sizes?: { cluster: number; size: number; share: number }[];
  projection?: { x: number[]; y: number[]; cluster: number[]; explained_variance?: number[] };
  cluster_profiles?: { cluster: number; size: number; means: Record<string, number | null>; top_categories?: Record<string, JsonValue> }[];
  overall_means?: Record<string, number | null>;
  k_search?: { params: Record<string, unknown>; cv_score?: number | null; silhouette?: number | null; [key: string]: unknown }[];
  // EXP-004 forecasting
  history?: { timestamps: string[]; values: (number | null)[] };
  backtest?: { origin: string; timestamps: string[]; actual: (number | null)[]; forecast: number[]; lower?: number[]; upper?: number[] }[];
  forecast?: { timestamps: string[]; forecast: number[]; lower?: number[]; upper?: number[]; interval_level?: number };
  frequency?: string;
  season_length?: number | null;
  [key: string]: unknown;
}

export interface Run {
  id: string;
  experiment_id: string;
  status: string;
  algorithm: string;
  params: Record<string, unknown>;
  /** numeric metrics, plus `problem_type` */
  metrics: Record<string, number | string>;
  duration_seconds: number | null;
  artifacts: RunArtifacts & { is_best?: boolean; warnings?: string[] };
  created_at?: string;
}

export interface ExperimentDetail {
  experiment: Experiment;
  runs: Run[];
  job: Job | null;
}

export interface CompareResponse {
  runs: Pick<Run, "id" | "experiment_id" | "algorithm" | "params" | "metrics">[];
  metrics: string[];
}

export interface ExplainResponse {
  predictions: JsonValue[];
  probabilities?: number[][];
  classes?: JsonValue[];
  shap: Record<string, number>[];
  base_value: number | number[];
  /** XAI-002a */
  force_plot?: ForcePlot[];
  lime?: LimeExplanation[];
}

export interface ForcePlot {
  base_value: number;
  output_value: number;
  features: { feature: string; value: JsonValue; shap: number; direction: "up" | "down" }[];
}

export interface LimeExplanation {
  prediction: JsonValue;
  local_prediction: number;
  intercept: number;
  r2: number;
  weights: { feature: string; value: JsonValue; weight: number }[];
  explained_class?: JsonValue;
}

// -- Registry & serving ------------------------------------------------------------

export type Stage = "none" | "staging" | "production" | "archived";

export interface RegisteredModel {
  id: string;
  name: string;
  description?: string | null;
  latest_version?: number | null;
  production_version?: number | null;
  created_at?: string;
}

export interface RegisterResponse {
  model_id: string;
  name: string;
  version: number;
  model_version_id: string;
  stage: Stage;
}

export interface SignatureField {
  name: string;
  type: string;
  categories?: string[];
  min?: number | null;
  max?: number | null;
}

export interface ModelVersion {
  id: string;
  algorithm?: string | null;
  version: number;
  stage: Stage;
  run_id: string;
  metrics: Record<string, number>;
  signature: unknown;
  created_at: string;
}

export interface ModelDetail {
  model: RegisteredModel;
  versions: ModelVersion[];
}

export interface EndpointRoute {
  model_version_id: string;
  /** 0–100; routes must add up to 100 */
  weight: number;
}

export interface EndpointRouteOut extends EndpointRoute {
  model_id: string;
  version: number;
  run_id?: string;
}

export interface EndpointCreate {
  name: string;
  /** give model_id (optionally version) or routes */
  model_id?: string;
  version?: number;
  routes?: EndpointRoute[];
  min_replicas?: number;
  log_payloads?: boolean;
  cors_origins?: string[];
}

export interface ServingEndpoint {
  id: string;
  name: string;
  routes: EndpointRouteOut[];
  min_replicas: number;
  log_payloads: boolean;
  cors_origins: string[];
  status: string;
  url: string;
  created_at?: string;
}

export interface EndpointPatch {
  routes?: EndpointRoute[];
  min_replicas?: number;
  log_payloads?: boolean;
  cors_origins?: string[];
  status?: "active" | "paused";
}

export interface PredictResponse {
  predictions: JsonValue[];
  probabilities?: number[][] | null;
  classes?: JsonValue[] | null;
  /** the version that served the request (A/B routing) */
  model_version: number | string | { model_id: string; version: number };
  /** SHAP contributions per instance when `explain` is true */
  shap?: Record<string, number>[] | null;
  base_value?: number | number[] | null;
  explanations?: Record<string, number>[] | null;
}

/** Forecasting endpoint response */
export interface ForecastResponse {
  horizon: number;
  timestamps: string[];
  predictions: number[];
  lower?: number[];
  upper?: number[];
  interval_level?: number;
  model_version: number | string | { model_id: string; version: number };
}

export type DriftStatus = "ok" | "warn" | "alert" | "insufficient_data" | "no_data" | "not_applicable";

export interface DriftFeature {
  feature: string;
  type?: string;
  psi: number | null;
  status: DriftStatus | string;
  bins?: string[];
  expected?: number[];
  actual?: number[];
  samples?: number;
}

export interface DriftReport {
  endpoint: string;
  window_hours: number;
  thresholds: { warn: number; alert: number };
  min_samples: number;
  samples: number;
  status: DriftStatus | string;
  model_version?: { model_version_id: string; samples: number } | null;
  features: DriftFeature[];
  prediction: { psi: number | null; status: DriftStatus | string; bins?: string[]; expected?: number[]; actual?: number[] } | null;
  by_version?: Record<string, unknown>;
}

export interface EndpointMetrics {
  window_hours?: number;
  requests: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  by_version: Record<string, { requests?: number; errors?: number; p50_ms?: number; p95_ms?: number; p99_ms?: number }>;
}

// -- Analytics --------------------------------------------------------------------

export type ChartType =
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

export const CHART_TYPES: ChartType[] = [
  "bar",
  "line",
  "area",
  "scatter",
  "pie",
  "heatmap",
  "histogram",
  "box",
  "treemap",
  "funnel",
  "gauge",
  "sankey",
  "waterfall",
];

export type Aggregation = "sum" | "avg" | "count" | "min" | "max";

export interface ChartSpec {
  type: ChartType | string;
  x?: string | null;
  y?: string | null;
  series?: string | null;
  aggregation?: Aggregation | null;
}

export interface AnalyticParameter {
  name: string;
  type: "string" | "number" | "date";
  default: string | number | null;
}

export interface AnalyticCreate {
  dataset_id: string;
  name: string;
  sql: string;
  chart: ChartSpec;
  parameters: AnalyticParameter[];
}

export interface Analytic extends AnalyticCreate {
  id: string;
  created_at?: string;
  created_by?: string;
}

export interface TabularResult {
  columns: string[];
  rows: unknown[][] | Row[];
  truncated?: boolean;
  /** Server-computed KPI / alert fields (widget data without custom SQL) */
  value?: number | null;
  sparkline?: [string, number][];
  target?: number;
  vs_target?: number | null;
  status?: string | null;
  static?: boolean;
  cached?: boolean;
}

// -- Dashboards -------------------------------------------------------------------

/**
 * `custom_html` is a UI-only type: the API stores it as a `table` widget with `config.custom_html`, so the
 * server still computes its data (see lib/embed.ts).
 */
export type WidgetType = "chart" | "kpi" | "table" | "text" | "filter" | "image" | "prediction" | "alert" | "iframe" | "custom_html";

export interface Threshold {
  op: ">" | ">=" | "<" | "<=" | "==" | "!=";
  value: number;
  color: string;
}

export interface ConditionalFormat {
  column: string;
  op: Threshold["op"];
  value: number | string;
  color: string;
}

export interface WidgetConfig {
  analytic_id?: string;
  dataset_id?: string;
  sql?: string;
  chart?: ChartSpec;
  /** trend = date column for the server-side sparkline (grain: day…year) */
  kpi?: { value: string; aggregation?: "sum" | "avg" | "count" | "min" | "max" | "median"; target?: number | null; trend?: string | null; grain?: "day" | "week" | "month" | "quarter" | "year" };
  /** table widgets without custom SQL */
  columns?: string[];
  sort?: { column: string; desc?: boolean };
  page_size?: number;
  text?: string;
  image_url?: string;
  filter?: { column: string; kind: "dropdown" | "multiselect" | "slider" | "date"; dataset_id: string };
  endpoint?: string;
  /** WDG-009 */
  iframe_url?: string;
  /** WDG-010: rendered only inside a sandboxed srcdoc iframe */
  custom_html?: { html: string };
  thresholds?: Threshold[];
  conditional_format?: ConditionalFormat[];
  value_column?: string;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  layout: WidgetLayout;
  config: WidgetConfig;
}

export interface DashboardPage {
  id: string;
  title: string;
  widgets: Widget[];
}

export type FilterValue = string | number | (string | number)[] | { min?: string | number; max?: string | number };

export interface GlobalFilter {
  id: string;
  column: string;
  kind: "dropdown" | "multiselect" | "slider" | "date";
  default: FilterValue | null;
}

export interface DashboardSpec {
  pages: DashboardPage[];
  filters?: GlobalFilter[];
  date_range?: { column: string; default: string } | null;
  theme?: { mode: "light" | "dark"; primary?: string };
  /** null = off; otherwise 5..86400 */
  refresh_seconds?: number | null;
}

export interface Dashboard {
  id: string;
  name: string;
  spec: DashboardSpec;
  archived: boolean;
  owner_id: string;
  /** user id (or "*") → editor | viewer */
  shares: Record<string, string>;
  your_role: "owner" | "editor" | "viewer" | string;
  created_at?: string;
  updated_at?: string;
}

export interface DashboardTemplate {
  id: string;
  name: string;
  description?: string;
}

// -- Webhooks -------------------------------------------------------------------

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  created_at?: string;
  active?: boolean;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  response_code?: number | null;
  attempts?: number;
  created_at?: string;
  delivered_at?: string | null;
}

// -- Phase 2 data layer ------------------------------------------------------------------

export type ColumnAnnotation = "pii" | "sensitive" | "derived" | "target" | "id";
export const COLUMN_ANNOTATIONS: ColumnAnnotation[] = ["pii", "sensitive", "derived", "target", "id"];

export interface SchemaDiffField {
  name: string;
  type: string;
  nullable: boolean;
}

export interface SchemaDiffEntity {
  name: string;
  added_fields: SchemaDiffField[];
  removed_fields: SchemaDiffField[];
  retyped_fields: { field: string; from_type: string; to_type: string }[];
  changed_fields: { field: string; attribute: string; from: unknown; to: unknown }[];
}

export interface SchemaDiff {
  identical: boolean;
  added_entities: string[];
  removed_entities: string[];
  entities: SchemaDiffEntity[];
  breaking: boolean;
  summary: string[];
}

export interface SchemaVersion {
  version: number;
  content_hash: string;
  source_format?: string | null;
  message?: string | null;
  created_by: string;
  created_at: string;
  schema?: Schema | null;
}

export interface SavedSchema {
  id: string;
  project_id: string;
  name: string;
  current_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  versions?: SchemaVersion[] | null;
}

export interface SaveSchemaResponse {
  schema_record: SavedSchema;
  version: number;
  created: boolean;
  diff?: SchemaDiff | null;
}

export interface EvolutionResponse {
  dataset: DatasetRecord;
  previous_version: number;
  mode: "append" | "replace";
  inference: InferenceResult;
  diff: SchemaDiff;
}

export interface AnnotationsOut {
  dataset_id: string;
  version: number;
  annotations: Record<string, Record<string, ColumnAnnotation[]>>;
}

export interface AdvancedProfileRequest {
  isolation_forest?: { enabled: boolean; contamination?: "auto" | number; n_estimators?: number; max_rows?: number; columns?: string[]; seed?: number };
  near_duplicates?: { enabled: boolean; columns?: string[]; threshold?: number; window?: number; max_rows?: number };
  missing_patterns?: { enabled: boolean; alpha?: number; max_rows?: number; max_columns?: number };
}

export interface AdvancedProfile {
  row_count: number;
  isolation_forest?: {
    columns: string[];
    contamination: number | string;
    sampled_rows: number;
    total_rows: number;
    outlier_count: number;
    outlier_fraction: number;
    examples: { row: number; score: number; values: Row }[];
    message?: string | null;
  } | null;
  near_duplicates?: {
    columns: string[];
    threshold: number;
    method: string;
    rows_scanned: number;
    sampled: boolean;
    pair_count: number;
    cluster_count: number;
    duplicate_rows: number;
    examples: { rows: [number, number]; score: number; values: [Row, Row] }[];
  } | null;
  missing_patterns?: {
    heuristic: boolean;
    method: string;
    rows_analyzed: number;
    columns: string[];
    missing_fraction: Record<string, number>;
    co_missingness: Record<string, Record<string, number>>;
    indicator_correlation: Record<string, Record<string, number | null>>;
    patterns: { missing_columns: string[]; count: number; fraction: number }[];
    mechanisms: { column: string; missing_fraction: number; label: string; associated_with: string[]; min_adjusted_p_value?: number | null; evidence: string }[];
  } | null;
}

export type ConnectorKind = "s3" | "gcs" | "postgresql" | "mysql";

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind | string;
  config: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface ConnectorCreate {
  name: string;
  kind: ConnectorKind;
  config: Record<string, unknown>;
  /** write-only: stored in the secret manager, never returned */
  credentials: Record<string, unknown>;
}

export interface ConnectorImport {
  project_id?: string;
  name?: string;
  key?: string;
  prefix?: string;
  query?: string;
  row_limit?: number;
}

// -- Phase 2 platform features ------------------------------------------------------------------

export interface ProviderHealth {
  provider: string;
  requests: number;
  errors: number;
  refusals: number;
  error_rate: number;
  refusal_rate: number;
  latency_ms: { p50: number | null; p95: number | null; max: number | null };
  last_outcome: string | null;
  seconds_since_last: number | null;
  breaker?: "closed" | "open" | "half_open" | string;
  status: "healthy" | "degraded" | "unhealthy" | string;
}

export interface BreakerConfig {
  enabled: boolean;
  failure_threshold: number;
  open_seconds: number;
}

export interface LLMHealth {
  window_seconds: number;
  breaker: BreakerConfig;
  providers: ProviderHealth[];
}

export interface PromptVersion {
  ref: string;
  version: number;
  provider: string;
  scope: string;
  active: boolean;
  description: string | null;
  system: string;
  created_by: string;
  created_at: string;
}

export interface PromptTemplate {
  template_id: string;
  description: string;
  variables: string[];
  default: { ref: string; system: string };
  effective: { ref: string; source: "default" | "platform" | "tenant" | string } | null;
  tenant_versions?: PromptVersion[];
  platform_versions?: PromptVersion[];
}

export const NOTIFICATION_KINDS = ["job.succeeded", "job.failed", "model.registered", "endpoint.deployed", "dataset.version_created", "endpoint.threshold"] as const;

export interface ChatDestination {
  id: string;
  kind: "slack" | "teams";
  name: string;
  host: string;
  events: string[];
  active: boolean;
  created_at: string;
}

export interface OAuthClient {
  id: string;
  client_id: string;
  name: string;
  role: Role;
  scopes: string[];
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export type OAuthClientWithSecret = OAuthClient & { client_secret: string; token_url: string };

export interface NetworkPolicy {
  allow: string[];
  deny: string[];
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  members: string[];
  projects: string[];
  created_at: string;
}

export interface ScimTokenStatus {
  configured: boolean;
  created_at: string | null;
  created_by: string | null;
}

export type ConsentPolicy = "terms" | "privacy" | "llm_processing";

export interface ConsentRecord {
  id: string;
  user_id: string;
  role: string;
  policy: ConsentPolicy;
  version: string;
  accepted_at: string;
  withdrawn_at: string | null;
}

export interface ConsentSettings {
  llm_requires_consent: boolean;
  llm_addendum_version: string;
  llm_consent_given?: boolean;
}

export interface CostReport {
  start: string;
  end: string;
  currency: string;
  rates: Record<string, number>;
  total_cost_usd: number;
  llm: { cost_usd: number; by_model: Record<string, number>; input_tokens: number; output_tokens: number; unpriced_requests: number };
  compute: { seconds: number; cost_usd: number; by_job_type: Record<string, number> };
  storage: { bytes: number; gb_months: number; cost_usd: number; basis: string };
  api: { requests: number; cost_usd: number; by_key: Record<string, number> };
}

export interface PublicLink {
  id: string;
  dashboard_id?: string;
  status: "active" | "expired" | "revoked" | string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export type PublicLinkWithToken = PublicLink & { token: string; path: string };

export interface InboundHook {
  id: string;
  name: string;
  action: "predict" | "ingest";
  config: { endpoint?: string; dataset_id?: string; mode?: "append" | "replace" };
  active: boolean;
  path: string;
  created_by: string;
  created_at: string;
  last_triggered_at: string | null;
}

export type InboundHookWithSecret = InboundHook & { secret: string; signature_header?: string };

export type InboundHookCreate =
  | { name: string; action: "predict"; endpoint: string }
  | { name: string; action: "ingest"; dataset_id: string; mode: "append" | "replace" };
