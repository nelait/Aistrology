"""Google Cloud implementations (AP_CLOUD_PROVIDER=gcp): GCS, Secret Manager, Cloud KMS, Pub/Sub.

SDKs are imported lazily so the other providers don't need them installed.
Clients can be injected for tests.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .base import KeyManager, ObjectNotFound, ObjectStore, Queue, QueueMessage, SecretStore


class GCSObjectStore(ObjectStore):
    def __init__(self, bucket: str, *, project: str | None = None, client: Any = None):
        if client is None:
            from google.cloud import storage

            client = storage.Client(project=project)
        self.client = client
        self.bucket = client.bucket(bucket)

    def put_file(self, key: str, path: Path) -> None:
        self.bucket.blob(key).upload_from_filename(str(path))

    def put_bytes(self, key: str, data: bytes) -> None:
        self.bucket.blob(key).upload_from_string(data)

    def get_bytes(self, key: str) -> bytes:
        from google.api_core.exceptions import NotFound

        try:
            return self.bucket.blob(key).download_as_bytes()
        except NotFound as exc:
            raise ObjectNotFound(key) from exc

    def download(self, key: str, path: Path) -> None:
        from google.api_core.exceptions import NotFound

        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.bucket.blob(key).download_to_filename(str(path))
        except NotFound as exc:
            path.unlink(missing_ok=True)
            raise ObjectNotFound(key) from exc

    def exists(self, key: str) -> bool:
        return self.bucket.blob(key).exists()

    def list(self, prefix: str) -> Iterator[tuple[str, int]]:
        for blob in self.client.list_blobs(self.bucket, prefix=prefix):
            yield blob.name, int(blob.size or 0)

    def delete(self, key: str) -> None:
        from google.api_core.exceptions import NotFound

        try:
            self.bucket.blob(key).delete()
        except NotFound:
            pass


class GCPSecretStore(SecretStore):
    """One Secret Manager secret per (tenant, name): ``{prefix}--{tenant}--{name}``, labelled with the tenant."""

    def __init__(self, project: str, prefix: str, *, client: Any = None):
        if client is None:
            from google.cloud import secretmanager

            client = secretmanager.SecretManagerServiceClient()
        self.client = client
        self.project = project
        self.prefix = prefix

    def _secret_id(self, tenant_id: str, name: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", name)
        return f"{self.prefix}--{tenant_id}--{safe}"

    def _parent(self) -> str:
        return f"projects/{self.project}"

    def put(self, tenant_id: str, name: str, value: str) -> None:
        from google.api_core.exceptions import AlreadyExists

        secret_id = self._secret_id(tenant_id, name)
        try:
            self.client.create_secret(
                request={
                    "parent": self._parent(),
                    "secret_id": secret_id,
                    "secret": {"replication": {"automatic": {}}, "labels": {"tenant": tenant_id, "app": self.prefix}},
                }
            )
        except AlreadyExists:
            pass
        self.client.add_secret_version(request={"parent": f"{self._parent()}/secrets/{secret_id}", "payload": {"data": value.encode()}})

    def get(self, tenant_id: str, name: str) -> str | None:
        from google.api_core.exceptions import NotFound

        path = f"{self._parent()}/secrets/{self._secret_id(tenant_id, name)}/versions/latest"
        try:
            return self.client.access_secret_version(request={"name": path}).payload.data.decode()
        except NotFound:
            return None

    def delete(self, tenant_id: str, name: str) -> None:
        from google.api_core.exceptions import NotFound

        try:
            self.client.delete_secret(request={"name": f"{self._parent()}/secrets/{self._secret_id(tenant_id, name)}"})
        except NotFound:
            pass

    def names(self, tenant_id: str) -> list[str]:
        marker = f"{self.prefix}--{tenant_id}--"
        out = []
        for secret in self.client.list_secrets(request={"parent": self._parent(), "filter": f"labels.tenant={tenant_id}"}):
            secret_id = secret.name.rsplit("/", 1)[-1]
            if secret_id.startswith(marker):
                out.append(secret_id[len(marker) :])
        return sorted(out)


class GCPKeyManager(KeyManager):
    """Cloud KMS symmetric key. The tenant ID is passed as additional authenticated data."""

    def __init__(self, key_name: str, *, client: Any = None):
        if client is None:
            from google.cloud import kms

            client = kms.KeyManagementServiceClient()
        self.client = client
        self.key_name = key_name

    def wrap(self, tenant_id: str, plaintext_key: bytes) -> bytes:
        response = self.client.encrypt(
            request={"name": self.key_name, "plaintext": plaintext_key, "additional_authenticated_data": tenant_id.encode()}
        )
        return response.ciphertext

    def unwrap(self, tenant_id: str, wrapped_key: bytes) -> bytes:
        response = self.client.decrypt(
            request={"name": self.key_name, "ciphertext": wrapped_key, "additional_authenticated_data": tenant_id.encode()}
        )
        return response.plaintext


class PubSubQueue(Queue):
    """Pub/Sub topic + pull subscription. The subscription's dead-letter policy (Terraform) handles poison messages."""

    def __init__(self, topic: str, subscription: str, *, publisher: Any = None, subscriber: Any = None):
        if publisher is None or subscriber is None:
            from google.cloud import pubsub_v1

            publisher = publisher or pubsub_v1.PublisherClient()
            subscriber = subscriber or pubsub_v1.SubscriberClient()
        self.publisher = publisher
        self.subscriber = subscriber
        self.topic = topic
        self.subscription = subscription

    def publish(self, body: dict) -> str:
        return self.publisher.publish(self.topic, json.dumps(body).encode()).result(timeout=30)

    def receive(self, max_messages: int = 1, wait_seconds: float = 10.0) -> list[QueueMessage]:
        from google.api_core.exceptions import DeadlineExceeded

        try:
            response = self.subscriber.pull(
                request={"subscription": self.subscription, "max_messages": max_messages}, timeout=max(wait_seconds, 1.0)
            )
        except DeadlineExceeded:
            return []
        return [
            QueueMessage(id=m.message.message_id, body=json.loads(m.message.data), receipt=m.ack_id) for m in response.received_messages
        ]

    def ack(self, message: QueueMessage) -> None:
        self.subscriber.acknowledge(request={"subscription": self.subscription, "ack_ids": [message.receipt]})

    def nack(self, message: QueueMessage) -> None:
        self.subscriber.modify_ack_deadline(
            request={"subscription": self.subscription, "ack_ids": [message.receipt], "ack_deadline_seconds": 0}
        )
