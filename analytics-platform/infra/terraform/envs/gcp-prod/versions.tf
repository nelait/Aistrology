terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state (example). Create the bucket once, out of band, with
  # versioning on, then uncomment and run `terraform init -migrate-state`.
  #
  # backend "gcs" {
  #   bucket = "my-org-analytics-tfstate-prod"
  #   prefix = "analytics-platform/gcp-prod"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = {
    app        = var.name
    env        = var.env
    managed-by = "terraform"
  }
}
