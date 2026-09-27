# -----------------------------------------------------------------------------
# KMS: customer-managed key for datasets, RDS, SQS, secrets, logs, EKS secrets.
# The app uses it to wrap per-tenant data keys (SEC-001, SOC-CON-004).
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${var.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${local.prefix} data key"
  enable_key_rotation     = true
  rotation_period_in_days = var.kms_rotation_period_days
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
  tags                    = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

# -----------------------------------------------------------------------------
# S3: datasets bucket (versioning, SSE-KMS, public access blocked, TLS-only)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "datasets" {
  bucket_prefix = "${local.prefix}-datasets-"
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_ownership_controls" "datasets" {
  bucket = aws_s3_bucket.datasets.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "datasets" {
  bucket                  = aws_s3_bucket.datasets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "datasets" {
  bucket = aws_s3_bucket.datasets.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "datasets" {
  bucket = aws_s3_bucket.datasets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "datasets" {
  bucket = aws_s3_bucket.datasets.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.datasets]
}

data "aws_iam_policy_document" "datasets_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.datasets.arn, "${aws_s3_bucket.datasets.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "datasets" {
  bucket = aws_s3_bucket.datasets.id
  policy = data.aws_iam_policy_document.datasets_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.datasets]
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL 16: Multi-AZ, encrypted, TLS enforced, 7d+ backups
# -----------------------------------------------------------------------------

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.prefix}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "Postgres access from EKS only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.prefix}-db" })
}

resource "aws_vpc_security_group_ingress_rule" "db_from_eks" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from EKS pods/nodes"
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.prefix}-pg16"
  family = "postgres16"
  tags   = local.tags

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "${local.prefix}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name

  # SOC-AVL-003: automated backups + PITR (5-minute RPO).
  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "02:00-03:00"
  maintenance_window       = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefix}-pg-final"

  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  iam_database_authentication_enabled   = true

  tags = local.tags
}

locals {
  database_url = format(
    "postgresql+psycopg://%s:%s@%s:%d/%s?sslmode=require",
    aws_db_instance.this.username,
    random_password.db.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  )
}

# -----------------------------------------------------------------------------
# Secrets Manager: JWT signing secret (placeholder value) and database URL
# -----------------------------------------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${var.secret_prefix}/platform/${var.jwt_secret_name}"
  description             = "JWT signing key for the Analytics Platform API"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
  tags                    = merge(local.tags, { tenant = "platform" })
}

# Placeholder value (the app would also auto-create the secret if missing).
# Rotate out-of-band; Terraform ignores later values.
resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.secret_prefix}/platform/database-url"
  description             = "AP_DATABASE_URL for the Analytics Platform"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = local.database_url
}

# -----------------------------------------------------------------------------
# SQS: jobs queue + dead-letter queue (SOC-PI-004)
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "jobs_dlq" {
  name                              = "${local.prefix}-jobs-dlq"
  message_retention_seconds         = 1209600 # 14 days
  kms_master_key_id                 = aws_kms_key.data.arn
  kms_data_key_reuse_period_seconds = 300
  tags                              = local.tags
}

resource "aws_sqs_queue" "jobs" {
  name                              = "${local.prefix}-jobs"
  visibility_timeout_seconds        = var.sqs_visibility_timeout_seconds
  message_retention_seconds         = 345600 # 4 days
  receive_wait_time_seconds         = 20
  kms_master_key_id                 = aws_kms_key.data.arn
  kms_data_key_reuse_period_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = var.sqs_max_receive_count
  })

  tags = local.tags
}

resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# -----------------------------------------------------------------------------
# ECR: image repository (scan on push, immutable tags; SEC-008)
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name                 = "${local.prefix}/backend"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  tags                 = local.tags

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 100 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 100
        }
        action = { type = "expire" }
      },
    ]
  })
}
