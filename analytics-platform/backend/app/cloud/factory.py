"""Build the Cloud bundle for the configured provider (AP_CLOUD_PROVIDER = local | gcp | aws).

Adding a provider (e.g. Azure) means implementing the four interfaces in
``app.cloud.base`` and adding a branch here. No other module changes.
"""

from __future__ import annotations

from ..config import Settings
from .base import Cloud

SUPPORTED_PROVIDERS = ("local", "gcp", "aws")


class CloudConfigError(ValueError):
    pass


def _require(settings: Settings, *names: str) -> None:
    missing = [n for n in names if not getattr(settings, n)]
    if missing:
        env = ", ".join("AP_" + n.upper() for n in missing)
        raise CloudConfigError(f"AP_CLOUD_PROVIDER={settings.cloud_provider} requires {env}")


def build_cloud(settings: Settings) -> Cloud:
    provider = settings.cloud_provider.lower()
    if provider == "local":
        from .local import InMemoryQueue, LocalKeyManager, LocalObjectStore, LocalSecretStore

        root = settings.data_dir
        kms = LocalKeyManager(root / "local-kms" / "master.key")
        return Cloud(
            provider="local",
            objects=LocalObjectStore(root / "objects"),
            secrets=LocalSecretStore(root / "local-secrets" / "secrets.json", kms),
            kms=kms,
            queue=InMemoryQueue(),
        )
    if provider == "gcp":
        _require(settings, "gcp_project", "object_bucket", "gcp_kms_key", "gcp_pubsub_topic", "gcp_pubsub_subscription")
        from .gcp import GCPKeyManager, GCPSecretStore, GCSObjectStore, PubSubQueue

        return Cloud(
            provider="gcp",
            objects=GCSObjectStore(settings.object_bucket, project=settings.gcp_project),  # type: ignore[arg-type]
            secrets=GCPSecretStore(settings.gcp_project, settings.secret_prefix),  # type: ignore[arg-type]
            kms=GCPKeyManager(settings.gcp_kms_key),  # type: ignore[arg-type]
            queue=PubSubQueue(settings.gcp_pubsub_topic, settings.gcp_pubsub_subscription),  # type: ignore[arg-type]
        )
    if provider == "aws":
        _require(settings, "object_bucket", "aws_kms_key_id", "aws_sqs_queue_url")
        from .aws import AWSKeyManager, AWSSecretStore, S3ObjectStore, SQSQueue

        region = settings.aws_region
        return Cloud(
            provider="aws",
            objects=S3ObjectStore(settings.object_bucket, region=region, kms_key_id=settings.aws_kms_key_id),  # type: ignore[arg-type]
            secrets=AWSSecretStore(settings.secret_prefix, region=region, kms_key_id=settings.aws_kms_key_id),
            kms=AWSKeyManager(settings.aws_kms_key_id, region=region),  # type: ignore[arg-type]
            queue=SQSQueue(settings.aws_sqs_queue_url, region=region),  # type: ignore[arg-type]
        )
    raise CloudConfigError(f"unsupported AP_CLOUD_PROVIDER {settings.cloud_provider!r}; choose one of {SUPPORTED_PROVIDERS}")
