terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Remote state (example). Create the bucket (versioned, encrypted) once,
  # out of band, then uncomment and run `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket       = "my-org-analytics-tfstate-prod"
  #   key          = "analytics-platform/aws-prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      app        = var.name
      env        = var.env
      managed-by = "terraform"
    }
  }
}
