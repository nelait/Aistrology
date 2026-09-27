# -----------------------------------------------------------------------------
# Cloud SQL for PostgreSQL 16: regional HA, private IP only, PITR backups
# -----------------------------------------------------------------------------

resource "random_id" "db_suffix" {
  byte_length = 3
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "this" {
  project             = var.project_id
  name                = "${local.prefix}-pg-${random_id.db_suffix.hex}"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = "REGIONAL" # synchronous standby in another zone
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = local.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = true
    }

    # SOC-AVL-003: RPO <= 1h via point-in-time recovery.
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = var.db_backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = var.db_name
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = var.db_user
  instance = google_sql_database_instance.this.name
  password = random_password.db.result
}

locals {
  database_url = format(
    "postgresql+psycopg://%s:%s@%s:5432/%s?sslmode=require",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database_instance.this.private_ip_address,
    google_sql_database.app.name,
  )
}
