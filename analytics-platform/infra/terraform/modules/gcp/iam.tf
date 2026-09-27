# -----------------------------------------------------------------------------
# Workload Identity: the app's Google service account, bound to the Kubernetes
# service account, with least-privilege, resource-scoped grants (SOC-SEC-001).
# -----------------------------------------------------------------------------

resource "google_service_account" "app" {
  project      = var.project_id
  account_id   = "${local.prefix}-app"
  display_name = "Analytics Platform app (${var.env})"
}

# KSA <namespace>/<name> may impersonate the GSA.
resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.k8s_namespace}/${var.k8s_service_account}]"

  depends_on = [google_container_cluster.this]
}

# Storage: object admin on the datasets bucket only.
resource "google_storage_bucket_iam_member" "app_objects" {
  bucket = google_storage_bucket.datasets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}

# KMS: encrypt/decrypt with the data key only (envelope-encrypts tenant DEKs).
resource "google_kms_crypto_key_iam_member" "app" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.app.email}"
}

# Pub/Sub: publish to the jobs topic, consume the jobs subscription.
resource "google_pubsub_topic_iam_member" "app_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.jobs.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.app.email}"
}

resource "google_pubsub_subscription_iam_member" "app_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.jobs.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.app.email}"
}

# Secret Manager (SEC-005). The app creates, reads, rotates and deletes
# secrets named "<prefix>--<tenant>--<name>" (platform secrets use tenant
# "platform"). Grants are project-level with an IAM condition on the secret
# resource name, so only IDs starting with "<prefix>--" are reachable.
#
# NOTE: secrets.create/list are checked against the project, where the
# resource name is the project, not the new secret. If the conditional admin
# grant blocks auto-creation in your org, set secret_admin_unconditional =
# true (project-wide secretmanager.admin; the project is env-dedicated).
locals {
  secret_name_prefix = "projects/${local.project_number}/secrets/${var.secret_prefix}--"
  secret_condition   = "resource.name.startsWith(\"${local.secret_name_prefix}\")"
}

resource "google_project_iam_member" "app_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.app.email}"

  condition {
    title       = "secret-prefix-accessor"
    description = "Only secrets whose ID starts with ${var.secret_prefix}--"
    expression  = local.secret_condition
  }
}

resource "google_project_iam_member" "app_secret_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.app.email}"

  dynamic "condition" {
    for_each = var.secret_admin_unconditional ? [] : [1]
    content {
      title       = "secret-prefix-admin"
      description = "Create/rotate/delete only secrets whose ID starts with ${var.secret_prefix}--"
      expression  = local.secret_condition
    }
  }
}

# Listing secrets (metadata only, no payloads) is a project-level permission.
resource "google_project_iam_member" "app_secret_viewer" {
  project = var.project_id
  role    = "roles/secretmanager.viewer"
  member  = "serviceAccount:${google_service_account.app.email}"
}

# -----------------------------------------------------------------------------
# Cloud Armor (WAF) policy placeholder. Attach it to the GKE Ingress backend
# through a BackendConfig (see deploy/helm values-gcp.yaml). OWASP rules start
# in preview mode; flip `preview = false` once tuned (SOC-SEC-005).
# -----------------------------------------------------------------------------

resource "google_compute_security_policy" "waf" {
  project     = var.project_id
  name        = "${local.prefix}-waf"
  description = "Analytics Platform WAF (placeholder rules)"

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }

  rule {
    action   = "deny(403)"
    priority = 1000
    preview  = true
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "OWASP SQLi (preview)"
  }

  rule {
    action   = "deny(403)"
    priority = 1001
    preview  = true
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "OWASP XSS (preview)"
  }

  rule {
    action   = "throttle"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 1200
        interval_sec = 60
      }
    }
    description = "Per-IP rate limit"
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }

  depends_on = [google_project_service.apis]
}
