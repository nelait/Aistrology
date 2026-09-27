variable "project_id" {
  description = "GCP project for this environment (one project per env, SOC-SEC-004)."
  type        = string
}

variable "region" {
  description = "Region; choose US or EU per data-residency needs (SEC-002)."
  type        = string
  default     = "us-central1"
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

variable "master_authorized_networks" {
  description = "CIDRs allowed to reach the GKE control plane (CI runners, VPN)."
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = []
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
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

variable "deletion_protection" {
  type    = bool
  default = true
}
