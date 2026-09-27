# Environment for the backend (ConfigMap/Secret in the Helm chart).
# Sensitive because AP_DATABASE_URL embeds the DB password; read it with
#   terraform output -json app_env
output "app_env" {
  description = "Backend environment variables (AP_*) for this deployment."
  sensitive   = true
  value = {
    AP_CLOUD_PROVIDER          = "aws"
    AP_DATABASE_URL            = module.platform.database_url
    AP_OBJECT_BUCKET           = module.platform.bucket_name
    AP_GCP_PROJECT             = ""
    AP_GCP_LOCATION            = ""
    AP_GCP_KMS_KEY             = ""
    AP_GCP_PUBSUB_TOPIC        = ""
    AP_GCP_PUBSUB_SUBSCRIPTION = ""
    AP_AWS_REGION              = module.platform.region
    AP_AWS_KMS_KEY_ID          = module.platform.kms_key_arn
    AP_AWS_SQS_QUEUE_URL       = module.platform.sqs_queue_url
    AP_SECRET_PREFIX           = module.platform.secret_prefix
    AP_JWT_SECRET_NAME         = module.platform.jwt_secret_name
  }
}

output "irsa_role_arn" {
  description = "Helm: serviceAccount.awsRoleArn (eks.amazonaws.com/role-arn)."
  value       = module.platform.app_role_arn
}

output "image_repository" {
  description = "Helm: image.repository."
  value       = module.platform.ecr_repository_url
}

output "cluster_name" {
  value = module.platform.cluster_name
}

output "database_url_secret_name" {
  value = module.platform.database_url_secret_name
}

output "waf_acl_arn" {
  description = "Helm (values-aws.yaml): ingress annotation alb.ingress.kubernetes.io/wafv2-acl-arn."
  value       = module.platform.waf_acl_arn
}

output "update_kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.platform.cluster_name} --region ${module.platform.region}"
}
