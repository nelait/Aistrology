module "platform" {
  source = "../../modules/gcp"

  project_id                 = var.project_id
  region                     = var.region
  name                       = var.name
  env                        = var.env
  k8s_namespace              = var.k8s_namespace
  k8s_service_account        = var.k8s_service_account
  master_authorized_networks = var.master_authorized_networks
  db_tier                    = var.db_tier
  secret_prefix              = var.secret_prefix
  jwt_secret_name            = var.jwt_secret_name
  deletion_protection        = var.deletion_protection
}
