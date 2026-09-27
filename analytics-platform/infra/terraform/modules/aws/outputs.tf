output "region" {
  value = var.region
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value     = aws_eks_cluster.this.endpoint
  sensitive = true
}

output "database_endpoint" {
  value = aws_db_instance.this.address
}

output "database_url" {
  description = "Postgres URL for AP_DATABASE_URL (also stored in Secrets Manager)."
  value       = local.database_url
  sensitive   = true
}

output "database_url_secret_name" {
  value = aws_secretsmanager_secret.database_url.name
}

output "bucket_name" {
  value = aws_s3_bucket.datasets.bucket
}

output "kms_key_arn" {
  description = "KMS key ARN (valid wherever AWS APIs take a KeyId)."
  value       = aws_kms_key.data.arn
}

output "kms_key_id" {
  value = aws_kms_key.data.key_id
}

output "sqs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "sqs_dead_letter_queue_url" {
  value = aws_sqs_queue.jobs_dlq.url
}

output "secret_prefix" {
  value = var.secret_prefix
}

output "jwt_secret_name" {
  description = "AP_JWT_SECRET_NAME (short name; the app resolves it to <prefix>/platform/<name>)."
  value       = var.jwt_secret_name
}

output "jwt_secret_id" {
  value = aws_secretsmanager_secret.jwt.name
}

output "app_role_arn" {
  description = "Put this in the KSA annotation eks.amazonaws.com/role-arn."
  value       = aws_iam_role.app.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "waf_acl_arn" {
  description = "WAFv2 web ACL ARN for the ALB Ingress annotation."
  value       = aws_wafv2_web_acl.this.arn
}
