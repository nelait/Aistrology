output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "network_id" {
  value = google_compute_network.vpc.id
}

output "cluster_name" {
  value = google_container_cluster.this.name
}

output "cluster_endpoint" {
  value     = google_container_cluster.this.endpoint
  sensitive = true
}

output "database_instance" {
  description = "Cloud SQL instance connection name."
  value       = google_sql_database_instance.this.connection_name
}

output "database_private_ip" {
  value = google_sql_database_instance.this.private_ip_address
}

output "database_url" {
  description = "Postgres URL for AP_DATABASE_URL (also stored in Secret Manager)."
  value       = local.database_url
  sensitive   = true
}

output "database_url_secret_id" {
  value = google_secret_manager_secret.database_url.secret_id
}

output "bucket_name" {
  value = google_storage_bucket.datasets.name
}

output "kms_crypto_key_id" {
  description = "Full resource name of the data crypto key."
  value       = google_kms_crypto_key.data.id
}

output "pubsub_topic" {
  value = google_pubsub_topic.jobs.name
}

output "pubsub_subscription" {
  value = google_pubsub_subscription.jobs.name
}

output "pubsub_dead_letter_topic" {
  value = google_pubsub_topic.jobs_dead_letter.name
}

output "secret_prefix" {
  value = var.secret_prefix
}

output "jwt_secret_name" {
  description = "AP_JWT_SECRET_NAME (short name; the app resolves it to <prefix>--platform--<name>)."
  value       = var.jwt_secret_name
}

output "jwt_secret_id" {
  value = google_secret_manager_secret.jwt.secret_id
}

output "app_service_account_email" {
  description = "Put this in the KSA annotation iam.gke.io/gcp-service-account."
  value       = google_service_account.app.email
}

output "artifact_registry_url" {
  value = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "security_policy_name" {
  description = "Cloud Armor policy name for the GKE BackendConfig."
  value       = google_compute_security_policy.waf.name
}
