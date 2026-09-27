# -----------------------------------------------------------------------------
# IRSA role for the app pods: least-privilege, resource-scoped (SOC-SEC-001).
# -----------------------------------------------------------------------------

locals {
  oidc_issuer_host = replace(aws_eks_cluster.this.identity[0].oidc[0].issuer, "https://", "")
}

data "aws_iam_policy_document" "app_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_host}:sub"
      values   = ["system:serviceaccount:${var.k8s_namespace}:${var.k8s_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.prefix}-app"
  assume_role_policy = data.aws_iam_policy_document.app_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ListDatasetsBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.datasets.arn]
  }

  statement {
    sid = "DatasetsObjects"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.datasets.arn}/*"]
  }

  statement {
    sid = "DataKey"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.data.arn]
  }

  # The app creates/reads/rotates/deletes "<prefix>/<tenant>/<name>" secrets
  # (SEC-005); everything is scoped to the prefix.
  statement {
    sid       = "SecretsUnderPrefix"
    actions   = ["secretsmanager:*"]
    resources = ["arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:${var.secret_prefix}/*"]
  }

  # ListSecrets does not support resource-level permissions (metadata only).
  statement {
    sid       = "ListSecrets"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    sid = "JobsQueue"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.prefix}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

# -----------------------------------------------------------------------------
# GuardDuty (intrusion detection, SOC-SEC-005)
# -----------------------------------------------------------------------------

resource "aws_guardduty_detector" "this" {
  count = var.enable_guardduty ? 1 : 0

  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector_feature" "this" {
  for_each = var.enable_guardduty ? toset([
    "S3_DATA_EVENTS",
    "EKS_AUDIT_LOGS",
    "RDS_LOGIN_EVENTS",
    "EBS_MALWARE_PROTECTION",
  ]) : toset([])

  detector_id = aws_guardduty_detector.this[0].id
  name        = each.value
  status      = "ENABLED"
}

# -----------------------------------------------------------------------------
# WAF placeholder: attach to the ALB via the Ingress annotation
# alb.ingress.kubernetes.io/wafv2-acl-arn (see deploy/helm values-aws.yaml).
# Managed rule groups start in COUNT mode; switch to none{} once tuned.
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "this" {
  name        = "${local.prefix}-waf"
  description = "Analytics Platform WAF (placeholder rules)"
  scope       = "REGIONAL"
  tags        = local.tags

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesCommonRuleSet         = 10
      AWSManagedRulesKnownBadInputsRuleSet = 20
      AWSManagedRulesSQLiRuleSet           = 30
    }

    content {
      name     = rule.key
      priority = rule.value

      override_action {
        count {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 100

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "per-ip-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-waf"
    sampled_requests_enabled   = true
  }
}
