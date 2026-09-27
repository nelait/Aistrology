variable "region" {
  description = "Region; choose US or EU per data-residency needs (SEC-002)."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  type    = string
  default = "analytics"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "k8s_namespace" {
  type    = string
  default = "analytics"
}

variable "k8s_service_account" {
  type    = string
  default = "analytics-platform"
}

variable "eks_public_access_cidrs" {
  description = "CIDRs allowed to reach the EKS API (CI runners, VPN). Empty = private endpoint only."
  type        = list(string)
  default     = []
}

variable "node_instance_types" {
  type    = list(string)
  default = ["m6i.xlarge"]
}

variable "db_instance_class" {
  type    = string
  default = "db.m6g.large"
}

variable "secret_prefix" {
  description = "AP_SECRET_PREFIX (no separator suffix; the app appends its own)."
  type        = string
  default     = "analytics"
}

variable "jwt_secret_name" {
  type    = string
  default = "jwt-signing-key"
}

variable "enable_guardduty" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = true
}
