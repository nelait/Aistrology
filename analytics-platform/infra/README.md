# Analytics Platform infrastructure

The deployment setup supports **GCP and AWS equally**. You pick the cloud for each environment. Tenants are isolated inside the app (Postgres RLS, the `tenants/{tenant_id}/` object prefix, per-tenant data keys wrapped by the cloud KMS key, and per-tenant secrets). No cloud resource is created per tenant.

```
analytics-platform/
├── deploy/
│   ├── docker/Dockerfile                  # one image for the API and the worker
│   ├── docker/Dockerfile.dockerignore     # build-context excludes (BuildKit)
│   ├── docker/docker-compose.yml          # local dev: api (+ worker) + postgres:16
│   └── helm/analytics-platform/           # chart + values-gcp.yaml / values-aws.yaml
└── infra/terraform/
    ├── modules/gcp/   # VPC, GKE Autopilot, Cloud SQL, GCS, KMS, Secret Manager, Pub/Sub, AR, WI, Cloud Armor
    ├── modules/aws/   # VPC (3 AZ), EKS, RDS, S3, KMS, Secrets Manager, SQS, ECR, IRSA, GuardDuty, WAF
    └── envs/{gcp-prod,aws-prod}/          # root modules; `app_env` output = backend env
```

## 1. Choose a cloud

| | GCP (`envs/gcp-prod`) | AWS (`envs/aws-prod`) |
|---|---|---|
| Kubernetes | GKE Autopilot, regional, private nodes | EKS + managed node group across 3 AZs |
| Postgres 16 | Cloud SQL, regional HA, private IP, PITR | RDS Multi-AZ, encrypted, PITR |
| Objects | GCS (UBLA, versioning, CMEK) | S3 (versioning, SSE-KMS, public access blocked) |
| Keys | Cloud KMS key, rotated every 90 days | KMS CMK, rotated every 90 days |
| Jobs | Pub/Sub topic + subscription, DLQ after 5 deliveries | SQS + DLQ, `maxReceiveCount` 5 |
| Pod identity | Workload Identity | IRSA |
| WAF / IDS | Cloud Armor (OWASP rules in preview) | WAFv2 (managed rules in count mode) + GuardDuty |

Use one project or account **per environment** (SOC-SEC-004). Pick a US or EU region to match data residency (SEC-002). To add a staging environment, copy `envs/<cloud>-prod` to `envs/<cloud>-staging` and change `env` and the project or account.

## 2. Apply Terraform

Prerequisites: Terraform 1.6 or later, plus `gcloud` or `aws` credentials that can administer the target project or account.

```bash
cd analytics-platform/infra/terraform/envs/gcp-prod      # or aws-prod
cp terraform.tfvars.example terraform.tfvars             # edit it (git-ignored)
# Optional but recommended: uncomment the backend "gcs"/"s3" block in versions.tf.
terraform init
terraform plan -out tf.plan
terraform apply tf.plan
```

Things to know:

- **Deletion protection** is on for Cloud SQL, GKE and RDS, and the KMS keys have `prevent_destroy`. Destroying an environment is deliberately hard.
- **GuardDuty** allows only one detector per account and region. If one already exists, set `enable_guardduty = false`.
- **WAF rules** start in preview mode (Cloud Armor) or count mode (AWS). Switch them to enforcing once they are tuned. On GCP, turn off `preview` in `modules/gcp/iam.tf`. On AWS, change `override_action { count {} }` to `none {}` in `modules/aws/iam_security.tf`.
- **Placeholder secrets.** A random JWT signing key and the database URL are written to Secret Manager or Secrets Manager. This means both values are also in Terraform state, so keep the state bucket private and encrypted. Rotate the JWT key out of band. Terraform ignores later versions of it.
- **Kubernetes API access:** set `master_authorized_networks` (GCP) or `eks_public_access_cidrs` (AWS) to your VPN or CI egress CIDRs.

## 3. Build and push the image

The build context is the backend directory. The image installs `/src[gcp,aws]`, so the same image runs on either cloud. It runs as UID 10001 and has no build tools.

```bash
TAG=$(git rev-parse --short HEAD)
docker build -f analytics-platform/deploy/docker/Dockerfile -t analytics-platform-backend:$TAG analytics-platform/backend

# GCP (Artifact Registry)
REPO=$(terraform -chdir=analytics-platform/infra/terraform/envs/gcp-prod output -raw image_repository)
gcloud auth configure-docker ${REPO%%/*}
docker tag analytics-platform-backend:$TAG $REPO/backend:$TAG && docker push $REPO/backend:$TAG

# AWS (ECR)
REPO=$(terraform -chdir=analytics-platform/infra/terraform/envs/aws-prod output -raw image_repository)
aws ecr get-login-password | docker login --username AWS --password-stdin ${REPO%%/*}
docker tag analytics-platform-backend:$TAG $REPO:$TAG && docker push $REPO:$TAG
```

Both registries use **immutable tags**, so push a new tag, such as the git SHA, for every build. ECR scans images on push. CI also scans the image with grype.

## 4. Install with Helm

```bash
# Cluster credentials
eval "$(terraform -chdir=analytics-platform/infra/terraform/envs/gcp-prod output -raw get_credentials_command)"
#   or: eval "$(terraform -chdir=.../aws-prod output -raw update_kubeconfig_command)"

kubectl create namespace analytics

# Secret env: AP_DATABASE_URL (the only secret value the chart needs).
kubectl -n analytics create secret generic analytics-platform-secrets \
  --from-literal=AP_DATABASE_URL="$(terraform -chdir=analytics-platform/infra/terraform/envs/gcp-prod output -json app_env | jq -r .AP_DATABASE_URL)"
# In production, prefer External Secrets Operator syncing the
# <prefix>--platform--database-url (GCP) or <prefix>/platform/database-url (AWS) secret.

helm upgrade --install analytics-platform analytics-platform/deploy/helm/analytics-platform \
  -n analytics \
  -f analytics-platform/deploy/helm/analytics-platform/values-gcp.yaml \
  --set image.tag=$TAG
```

Before the first install, edit `values-gcp.yaml` or `values-aws.yaml` and replace the placeholder project, account, bucket, key and queue values with the Terraform outputs. You can also pass them with `--set`. The ServiceAccount identity annotation is chosen by `cloud`:

- `cloud: gcp` gives `iam.gke.io/gcp-service-account: <workload_identity_service_account>`.
- `cloud: aws` gives `eks.amazonaws.com/role-arn: <irsa_role_arn>`.

The Kubernetes namespace and ServiceAccount name must match the Terraform `k8s_namespace` and `k8s_service_account` values (default `analytics` / `analytics-platform`), because that is the identity Workload Identity or IRSA trusts. Install into the `analytics` namespace. The ServiceAccount then takes its name from the release name `analytics-platform`, or you can set `serviceAccount.name`.

What the chart deploys:

- An API Deployment with a Service, HPA, PDB and TLS Ingress. On GCP the Ingress uses GCE with a BackendConfig that attaches the Cloud Armor policy. On AWS it uses an ALB with an ACM certificate and the WAF ACL, and needs the AWS Load Balancer Controller.
- A worker Deployment (`python -m app.jobs.worker`) with its own HPA and PDB.
- Default-deny NetworkPolicies. They allow ingress to the API port only, and egress only to DNS, 443 and 5432. On GCP they also allow the GKE metadata server.
- Pods run as non-root with a read-only root filesystem. `/tmp` and `/data` (`AP_DATA_DIR`) are emptyDirs. Both Deployments use `/healthz` for liveness and readiness probes.

## 5. Environment variable mapping

`terraform output -json app_env` (sensitive) returns exactly these keys. Put `AP_DATABASE_URL` in the Kubernetes Secret and everything else in the Helm `env:` map. The chart sets `AP_CLOUD_PROVIDER` from `cloud` and leaves empty values out.

| Env var | GCP source | AWS source |
|---|---|---|
| `AP_CLOUD_PROVIDER` | `gcp` | `aws` |
| `AP_DATABASE_URL` | `postgresql+psycopg://…@<cloud-sql-private-ip>:5432/analytics?sslmode=require` | `postgresql+psycopg://…@<rds-endpoint>:5432/analytics?sslmode=require` |
| `AP_OBJECT_BUCKET` | GCS bucket name | S3 bucket name |
| `AP_GCP_PROJECT` | project ID | "" |
| `AP_GCP_LOCATION` | region | "" |
| `AP_GCP_KMS_KEY` | `projects/…/locations/…/keyRings/…/cryptoKeys/…` | "" |
| `AP_GCP_PUBSUB_TOPIC` | topic short name | "" |
| `AP_GCP_PUBSUB_SUBSCRIPTION` | subscription short name | "" |
| `AP_AWS_REGION` | "" | region |
| `AP_AWS_KMS_KEY_ID` | "" | KMS key ARN (valid wherever AWS takes a KeyId) |
| `AP_AWS_SQS_QUEUE_URL` | "" | jobs queue URL |
| `AP_SECRET_PREFIX` | `analytics` | `analytics` |
| `AP_JWT_SECRET_NAME` | `jwt-signing-key` | `jwt-signing-key` |

These settings are not Terraform outputs:

- `AP_DATA_DIR=/data` is the emptyDir scratch space and decrypted cache.
- `AP_INLINE_WORKER` is `0` in Kubernetes, because the worker Deployment consumes jobs. It is `1` in docker-compose.
- `AP_DEV_AUTH` must never be set in production. The chart refuses to render it unless `cloud=local`.

### Secret naming and IAM scope

The app builds secret names from `AP_SECRET_PREFIX`. It creates platform and per-tenant secrets itself when they are missing.

| | Platform JWT key | Tenant secret | IAM scope |
|---|---|---|---|
| GCP | `analytics--platform--jwt-signing-key` | `analytics--<tenant>--<name>` (label `tenant=<tenant>`) | `secretAccessor` + `secretmanager.admin` with the condition `resource.name.startsWith("projects/<num>/secrets/analytics--")`, plus project-level `secretmanager.viewer` so the app can list secrets |
| AWS | `analytics/platform/jwt-signing-key` | `analytics/<tenant>/<name>` | `secretsmanager:*` on `arn:…:secret:analytics/*`, plus `ListSecrets` on `*` |

**GCP caveat:** `secrets.create` is checked against the project. A condition on the secret name may therefore block the app from creating secrets itself. If that happens, set `secret_admin_unconditional = true` in `modules/gcp`. This grants project-wide `secretmanager.admin`, which is acceptable because each project serves only one environment.

The app's other grants are all scoped to single resources:

- GCP: `storage.objectAdmin` on the bucket, `cryptoKeyEncrypterDecrypter` on the key, `pubsub.publisher` on the topic and `pubsub.subscriber` on the subscription.
- AWS: S3 on the bucket, KMS on the key, and SQS on the jobs queue.

## 6. Local development

```bash
docker compose -f analytics-platform/deploy/docker/docker-compose.yml up --build
# separate worker instead of in-process jobs:
AP_INLINE_WORKER=0 docker compose -f analytics-platform/deploy/docker/docker-compose.yml --profile worker up --build
```

This runs with `AP_CLOUD_PROVIDER=local`. Datasets go on a shared `/data` volume and Postgres 16 runs in a container.

## 7. CI

`.github/workflows/analytics-platform-ci.yml` runs on changes under `analytics-platform/**`:

- **backend:** ruff lint and format check, pytest, bandit SAST (only high-severity findings fail the job) and pip-audit.
- **secrets:** gitleaks.
- **terraform:** `fmt -check`, then `init -backend=false` and `validate` for both environments.
- **helm:** `lint --strict` with each overlay.
- **docker:** builds the image without pushing, runs a `/healthz` smoke test against Postgres, then a grype image scan that fails on fixable critical CVEs.

Together these cover SEC-006 and SEC-008. DAST still needs a deployed staging environment.
