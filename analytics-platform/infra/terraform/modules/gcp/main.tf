# Analytics Platform on GCP: network, GKE, Cloud SQL, GCS, KMS, Secret
# Manager, Pub/Sub, Artifact Registry, Workload Identity and Cloud Armor.
#
# The module is tenant-agnostic: tenants are isolated inside the app (RLS,
# `tenants/{tenant_id}/` object prefixes, per-tenant data keys wrapped by the
# KMS key below), never by per-tenant cloud resources or labels.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  labels = merge(
    {
      app        = var.name
      env        = var.env
      managed-by = "terraform"
    },
    var.labels,
  )

  prefix          = "${var.name}-${var.env}"
  project_number  = data.google_project.this.number
  bucket_location = coalesce(var.bucket_location, upper(var.region))

  required_apis = [
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = var.enable_apis ? toset(local.required_apis) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# -----------------------------------------------------------------------------
# Network: custom VPC, private subnet, Cloud NAT, private service access
# -----------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "${local.prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "private" {
  project                  = var.project_id
  name                     = "${local.prefix}-private"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "nat" {
  project = var.project_id
  name    = "${local.prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${local.prefix}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Private services access so Cloud SQL gets a private IP inside the VPC.
resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = "${local.prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# -----------------------------------------------------------------------------
# Cloud KMS: key ring + crypto key (wraps per-tenant data keys, CMEK for GCS)
# -----------------------------------------------------------------------------

resource "google_kms_key_ring" "this" {
  project  = var.project_id
  name     = "${local.prefix}-keyring"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "data" {
  name            = "${local.prefix}-data"
  key_ring        = google_kms_key_ring.this.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.kms_rotation_period
  labels          = local.labels

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The GCS service agent must be able to use the key for CMEK.
data "google_storage_project_service_account" "gcs" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "gcs_cmek" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# -----------------------------------------------------------------------------
# GCS: datasets bucket (UBLA, versioning, CMEK, no public access)
# -----------------------------------------------------------------------------

resource "google_storage_bucket" "datasets" {
  project                     = var.project_id
  name                        = "${var.project_id}-${local.prefix}-datasets"
  location                    = local.bucket_location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.data.id
  }

  # SOC-PRV-004: deleted/overwritten objects are purged within 30 days.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.noncurrent_version_retention_days
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs_cmek]
}

# -----------------------------------------------------------------------------
# Artifact Registry (container images)
# -----------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "${local.prefix}-images"
  description   = "Analytics Platform container images"
  format        = "DOCKER"
  labels        = local.labels

  docker_config {
    immutable_tags = true
  }

  depends_on = [google_project_service.apis]
}
