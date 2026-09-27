module "platform" {
  source = "../../modules/aws"

  region                  = var.region
  name                    = var.name
  env                     = var.env
  k8s_namespace           = var.k8s_namespace
  k8s_service_account     = var.k8s_service_account
  eks_public_access_cidrs = var.eks_public_access_cidrs
  node_instance_types     = var.node_instance_types
  db_instance_class       = var.db_instance_class
  secret_prefix           = var.secret_prefix
  jwt_secret_name         = var.jwt_secret_name
  enable_guardduty        = var.enable_guardduty
  deletion_protection     = var.deletion_protection
}
