variable "region" {
  description = "AWS region (SEC-002: pick a US or EU region). Must match the provider's region."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Base name used as a prefix for every resource."
  type        = string
  default     = "analytics"
}

variable "env" {
  description = "Environment name (prod, staging, dev). Use a separate AWS account per environment (SOC-SEC-004)."
  type        = string
  default     = "prod"
}

variable "tags" {
  description = "Extra tags merged into the default {app, env} tags. Never put tenant identifiers here."
  type        = map(string)
  default     = {}
}

# --- Network -----------------------------------------------------------------

variable "vpc_cidr" {
  description = "VPC CIDR. Private subnets get /20s, public subnets /24s carved from it."
  type        = string
  default     = "10.30.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to span (SOC-AVL-002)."
  type        = number
  default     = 3
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway instead of one per AZ (cheaper, not AZ-fault-tolerant)."
  type        = bool
  default     = false
}

# --- EKS ---------------------------------------------------------------------

variable "eks_version" {
  description = "Kubernetes version for EKS."
  type        = string
  default     = "1.31"
}

variable "eks_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. Empty list disables the public endpoint."
  type        = list(string)
  default     = []
}

variable "node_instance_types" {
  description = "Instance types for the managed node group."
  type        = list(string)
  default     = ["m6i.xlarge"]
}

variable "node_min_size" {
  type    = number
  default = 3
}

variable "node_desired_size" {
  type    = number
  default = 3
}

variable "node_max_size" {
  type    = number
  default = 9
}

variable "node_disk_size_gb" {
  type    = number
  default = 100
}

variable "k8s_namespace" {
  description = "Kubernetes namespace the app runs in (used for the IRSA trust policy)."
  type        = string
  default     = "analytics"
}

variable "k8s_service_account" {
  description = "Kubernetes service account name the app pods use."
  type        = string
  default     = "analytics-platform"
}

# --- RDS ---------------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.m6g.large"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 500
}

variable "db_name" {
  type    = string
  default = "analytics"
}

variable "db_username" {
  type    = string
  default = "analytics_app"
}

variable "db_backup_retention_days" {
  description = "Automated backup retention (7-30; SOC-PRV-004 requires backups to expire within 30 days)."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_days >= 7 && var.db_backup_retention_days <= 30
    error_message = "db_backup_retention_days must be between 7 and 30."
  }
}

variable "deletion_protection" {
  description = "Deletion protection on RDS. Keep true in prod."
  type        = bool
  default     = true
}

# --- Storage / KMS / secrets / jobs -----------------------------------------

variable "noncurrent_version_retention_days" {
  description = "Expire noncurrent S3 object versions after this many days (SOC-PRV-004)."
  type        = number
  default     = 30
}

variable "kms_rotation_period_days" {
  description = "KMS automatic key rotation period."
  type        = number
  default     = 90
}

variable "secret_prefix" {
  description = <<-EOT
    AP_SECRET_PREFIX (no trailing slash). The app names secrets
    "<prefix>/<tenant>/<name>" (platform secrets use tenant "platform");
    IAM is scoped to "<prefix>/*".
  EOT
  type        = string
  default     = "analytics"
}

variable "jwt_secret_name" {
  description = "AP_JWT_SECRET_NAME. Stored as <prefix>/platform/<name>."
  type        = string
  default     = "jwt-signing-key"
}

variable "sqs_visibility_timeout_seconds" {
  type    = number
  default = 600
}

variable "sqs_max_receive_count" {
  description = "Receives before a job message moves to the DLQ (SOC-PI-004)."
  type        = number
  default     = 5
}

variable "enable_guardduty" {
  description = "Create a GuardDuty detector. Set false if one already exists in this account/region."
  type        = bool
  default     = true
}
