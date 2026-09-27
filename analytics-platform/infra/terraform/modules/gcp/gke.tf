# -----------------------------------------------------------------------------
# GKE Autopilot: regional (multi-zone), private nodes, Workload Identity
# -----------------------------------------------------------------------------

# Minimal node service account (instead of the Compute default SA).
resource "google_service_account" "nodes" {
  project      = var.project_id
  account_id   = "${local.prefix}-nodes"
  display_name = "Analytics Platform GKE nodes (${var.env})"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/autoscaling.metricsWriter",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "this" {
  project  = var.project_id
  name     = "${local.prefix}-gke"
  location = var.region # regional => control plane and nodes span zones (SOC-AVL-002)

  enable_autopilot    = true
  deletion_protection = var.deletion_protection

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.private.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_ipv4_cidr
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.master_authorized_networks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  release_channel {
    channel = var.gke_release_channel
  }

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  resource_labels = local.labels

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.nodes,
  ]
}
