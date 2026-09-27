# -----------------------------------------------------------------------------
# Secret Manager: JWT signing secret (placeholder value) and database URL
# -----------------------------------------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "jwt" {
  project   = var.project_id
  secret_id = "${var.secret_prefix}--platform--${var.jwt_secret_name}"
  labels    = merge(local.labels, { tenant = "platform" })

  # Keep secret material in the chosen region (SEC-002 data residency).
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# Placeholder value (the app would also auto-create the secret if missing).
# Rotate out-of-band (`gcloud secrets versions add ...`); Terraform ignores
# later versions.
resource "google_secret_manager_secret_version" "jwt" {
  secret      = google_secret_manager_secret.jwt.id
  secret_data = random_password.jwt.result

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "${var.secret_prefix}--platform--database-url"
  labels    = merge(local.labels, { tenant = "platform" })

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

# -----------------------------------------------------------------------------
# Pub/Sub: jobs topic + subscription with dead-letter topic (SOC-PI-004)
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "jobs" {
  project                    = var.project_id
  name                       = "${local.prefix}-jobs"
  labels                     = local.labels
  message_retention_duration = "604800s"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "jobs_dead_letter" {
  project                    = var.project_id
  name                       = "${local.prefix}-jobs-dlq"
  labels                     = local.labels
  message_retention_duration = "604800s"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "jobs" {
  project                    = var.project_id
  name                       = "${local.prefix}-jobs-worker"
  topic                      = google_pubsub_topic.jobs.id
  labels                     = local.labels
  ack_deadline_seconds       = var.pubsub_ack_deadline_seconds
  message_retention_duration = "604800s"
  enable_message_ordering    = false

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.jobs_dead_letter.id
    max_delivery_attempts = var.pubsub_max_delivery_attempts
  }
}

# Subscription on the DLQ so dead-lettered jobs are retained for inspection.
resource "google_pubsub_subscription" "jobs_dead_letter" {
  project                    = var.project_id
  name                       = "${local.prefix}-jobs-dlq-inspect"
  topic                      = google_pubsub_topic.jobs_dead_letter.id
  labels                     = local.labels
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

# The Pub/Sub service agent must be able to forward to the DLQ and ack the
# source subscription for dead-lettering to work.
locals {
  pubsub_service_agent = "serviceAccount:service-${local.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.jobs_dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "dlq_source_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.jobs.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
