# Environment for the backend (ConfigMap/Secret in the Helm chart).
# Sensitive because AP_DATABASE_URL embeds the DB password; read it with
#   terraform output -json app_env
output "app_env" {
  description = "Backend environment variables (AP_*) for this deployment."
  sensitive   = true
  value = {
    AP_CLOUD_PROVIDER          = "gcp"
    AP_DATABASE_URL            = module.platform.database_url
    AP_OBJECT_BUCKET           = module.platform.bucket_name
    AP_GCP_PROJECT             = module.platform.project_id
    AP_GCP_LOCATION            = module.platform.region
    AP_GCP_KMS_KEY             = module.platform.kms_crypto_key_id
    AP_GCP_PUBSUB_TOPIC        = module.platform.pubsub_topic
    AP_GCP_PUBSUB_SUBSCRIPTION = module.platform.pubsub_subscription
    AP_AWS_REGION              = ""
    AP_AWS_KMS_KEY_ID          = ""
    AP_AWS_SQS_QUEUE_URL       = ""
    AP_SECRET_PREFIX           = module.platform.secret_prefix
    AP_JWT_SECRET_NAME         = module.platform.jwt_secret_name
  }
}

output "workload_identity_service_account" {
  description = "Helm: serviceAccount.gcpServiceAccount (iam.gke.io/gcp-service-account)."
  value       = module.platform.app_service_account_email
}

output "image_repository" {
  description = "Push images here; Helm: image.repository = <this>/backend."
  value       = module.platform.artifact_registry_url
}

output "cluster_name" {
  value = module.platform.cluster_name
}

output "database_url_secret_id" {
  value = module.platform.database_url_secret_id
}

output "security_policy_name" {
  description = "Helm (values-gcp.yaml): gcp.backendConfig.securityPolicy."
  value       = module.platform.security_policy_name
}

output "get_credentials_command" {
  value = "gcloud container clusters get-credentials ${module.platform.cluster_name} --region ${module.platform.region} --project ${module.platform.project_id}"
}
