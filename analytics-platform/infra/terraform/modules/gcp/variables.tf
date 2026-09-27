variable "project_id" {
  description = "GCP project ID. Use a separate project per environment (SOC-SEC-004)."
  type        = string
}

variable "region" {
  description = "GCP region for all regional resources (SEC-002: pick a US or EU region)."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Base name used as a prefix for every resource."
  type        = string
  default     = "analytics"
}

variable "env" {
  description = "Environment name (prod, staging, dev)."
  type        = string
  default     = "prod"
}

variable "labels" {
  description = "Extra labels merged into the default {app, env} labels. Never put tenant identifiers here."
  type        = map(string)
  default     = {}
}

# --- Network -----------------------------------------------------------------

variable "subnet_cidr" {
  description = "Primary CIDR of the private subnet (nodes)."
  type        = string
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary range for GKE pods."
  type        = string
  default     = "10.20.0.0/14"
}

variable "services_cidr" {
  description = "Secondary range for GKE services."
  type        = string
  default     = "10.24.0.0/20"
}

variable "master_ipv4_cidr" {
  description = "/28 range for the private GKE control plane."
  type        = string
  default     = "172.16.0.0/28"
}

variable "master_authorized_networks" {
  description = "CIDRs allowed to reach the GKE control plane endpoint."
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []
}

# --- GKE ---------------------------------------------------------------------

variable "gke_release_channel" {
  description = "GKE release channel."
  type        = string
  default     = "REGULAR"
}

variable "k8s_namespace" {
  description = "Kubernetes namespace the app runs in (used for the Workload Identity binding)."
  type        = string
  default     = "analytics"
}

variable "k8s_service_account" {
  description = "Kubernetes service account name the app pods use."
  type        = string
  default     = "analytics-platform"
}

# --- Cloud SQL ---------------------------------------------------------------

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_disk_size_gb" {
  description = "Initial Cloud SQL disk size (auto-resize is on)."
  type        = number
  default     = 50
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "analytics"
}

variable "db_user" {
  description = "Application database user."
  type        = string
  default     = "analytics_app"
}

variable "db_backup_retention_days" {
  description = "Number of automated backups to keep. SOC-PRV-004 requires backups to expire within 30 days."
  type        = number
  default     = 14
}

variable "deletion_protection" {
  description = "Deletion protection on Cloud SQL and GKE. Keep true in prod."
  type        = bool
  default     = true
}

# --- Storage / KMS -----------------------------------------------------------

variable "bucket_location" {
  description = "Location of the datasets bucket. Defaults to var.region."
  type        = string
  default     = null
}

variable "noncurrent_version_retention_days" {
  description = "Delete noncurrent object versions after this many days (SOC-PRV-004)."
  type        = number
  default     = 30
}

variable "kms_rotation_period" {
  description = "Crypto key rotation period."
  type        = string
  default     = "7776000s" # 90 days
}

# --- Secrets / jobs ----------------------------------------------------------

variable "secret_prefix" {
  description = <<-EOT
    AP_SECRET_PREFIX. The app names secrets "<prefix>--<tenant>--<name>"
    (platform secrets use tenant "platform"); IAM is scoped to IDs starting
    with "<prefix>--". Secret IDs allow [A-Za-z0-9_-] only.
  EOT
  type        = string
  default     = "analytics"
}

variable "jwt_secret_name" {
  description = "AP_JWT_SECRET_NAME. Stored as secret ID <prefix>--platform--<name>."
  type        = string
  default     = "jwt-signing-key"
}

variable "secret_admin_unconditional" {
  description = <<-EOT
    Grant roles/secretmanager.admin on the whole project instead of only on
    secrets whose ID starts with "<prefix>--". Use only if the conditional
    grant turns out to block secret creation in your org.
  EOT
  type        = bool
  default     = false
}

variable "pubsub_max_delivery_attempts" {
  description = "Deliveries before a job message goes to the dead-letter topic (SOC-PI-004)."
  type        = number
  default     = 5
}

variable "pubsub_ack_deadline_seconds" {
  description = "Ack deadline for the jobs subscription."
  type        = number
  default     = 600
}

variable "enable_apis" {
  description = "Enable the required Google APIs on the project."
  type        = bool
  default     = true
}
