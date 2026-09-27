"""AWS implementations (AP_CLOUD_PROVIDER=aws): S3, Secrets Manager, KMS, SQS.

``boto3`` is imported lazily. Clients can be injected (tests use moto).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .base import KeyManager, ObjectNotFound, ObjectStore, Queue, QueueMessage, SecretStore


def _client(service: str, region: str, client: Any) -> Any:
    if client is not None:
        return client
    import boto3

    return boto3.client(service, region_name=region)


def _is_not_found(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    return code in ("404", "NoSuchKey", "NotFound", "ResourceNotFoundException")


class S3ObjectStore(ObjectStore):
    def __init__(self, bucket: str, *, region: str = "us-east-1", client: Any = None, kms_key_id: str | None = None):
        self.s3 = _client("s3", region, client)
        self.bucket = bucket
        # Bucket default encryption is SSE-KMS (Terraform); this makes it explicit per request too.
        self.extra = {"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": kms_key_id} if kms_key_id else {}

    def put_file(self, key: str, path: Path) -> None:
        self.s3.upload_file(str(path), self.bucket, key, ExtraArgs=self.extra or None)

    def put_bytes(self, key: str, data: bytes) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, **self.extra)

    def get_bytes(self, key: str) -> bytes:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception as exc:
            if _is_not_found(exc):
                raise ObjectNotFound(key) from exc
            raise

    def download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.s3.download_file(self.bucket, key, str(path))
        except Exception as exc:
            path.unlink(missing_ok=True)
            if _is_not_found(exc):
                raise ObjectNotFound(key) from exc
            raise

    def exists(self, key: str) -> bool:
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as exc:
            if _is_not_found(exc):
                return False
            raise

    def list(self, prefix: str) -> Iterator[tuple[str, int]]:
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                yield obj["Key"], int(obj["Size"])

    def delete(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def delete_prefix(self, prefix: str) -> int:
        keys = [k for k, _ in self.list(prefix)]
        for i in range(0, len(keys), 1000):
            self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in keys[i : i + 1000]], "Quiet": True})
        return len(keys)


class AWSSecretStore(SecretStore):
    """One Secrets Manager secret per (tenant, name): ``{prefix}/{tenant}/{name}``, tagged with the tenant."""

    def __init__(self, prefix: str, *, region: str = "us-east-1", client: Any = None, kms_key_id: str | None = None):
        self.sm = _client("secretsmanager", region, client)
        self.prefix = prefix
        self.kms_key_id = kms_key_id

    def _id(self, tenant_id: str, name: str) -> str:
        return f"{self.prefix}/{tenant_id}/{re.sub(r'[^A-Za-z0-9_+=.@-]', '_', name)}"

    def put(self, tenant_id: str, name: str, value: str) -> None:
        secret_id = self._id(tenant_id, name)
        try:
            self.sm.put_secret_value(SecretId=secret_id, SecretString=value)
        except Exception as exc:
            if not _is_not_found(exc):
                raise
            extra = {"KmsKeyId": self.kms_key_id} if self.kms_key_id else {}
            self.sm.create_secret(Name=secret_id, SecretString=value, Tags=[{"Key": "tenant", "Value": tenant_id}], **extra)

    def get(self, tenant_id: str, name: str) -> str | None:
        try:
            return self.sm.get_secret_value(SecretId=self._id(tenant_id, name))["SecretString"]
        except Exception as exc:
            if _is_not_found(exc):
                return None
            raise

    def delete(self, tenant_id: str, name: str) -> None:
        try:
            self.sm.delete_secret(SecretId=self._id(tenant_id, name), ForceDeleteWithoutRecovery=True)
        except Exception as exc:
            if not _is_not_found(exc):
                raise

    def names(self, tenant_id: str) -> list[str]:
        marker = f"{self.prefix}/{tenant_id}/"
        out = []
        paginator = self.sm.get_paginator("list_secrets")
        for page in paginator.paginate(Filters=[{"Key": "name", "Values": [marker]}]):
            for secret in page.get("SecretList", []):
                if secret["Name"].startswith(marker):
                    out.append(secret["Name"][len(marker) :])
        return sorted(out)


class AWSKeyManager(KeyManager):
    """AWS KMS symmetric key. The tenant ID is bound through the encryption context."""

    def __init__(self, key_id: str, *, region: str = "us-east-1", client: Any = None):
        self.kms = _client("kms", region, client)
        self.key_id = key_id

    def wrap(self, tenant_id: str, plaintext_key: bytes) -> bytes:
        return self.kms.encrypt(KeyId=self.key_id, Plaintext=plaintext_key, EncryptionContext={"tenant": tenant_id})["CiphertextBlob"]

    def unwrap(self, tenant_id: str, wrapped_key: bytes) -> bytes:
        return self.kms.decrypt(KeyId=self.key_id, CiphertextBlob=wrapped_key, EncryptionContext={"tenant": tenant_id})["Plaintext"]


class SQSQueue(Queue):
    """SQS standard queue. The redrive policy (Terraform) moves poison messages to the DLQ."""

    def __init__(self, queue_url: str, *, region: str = "us-east-1", client: Any = None):
        self.sqs = _client("sqs", region, client)
        self.queue_url = queue_url

    def publish(self, body: dict) -> str:
        return self.sqs.send_message(QueueUrl=self.queue_url, MessageBody=json.dumps(body))["MessageId"]

    def receive(self, max_messages: int = 1, wait_seconds: float = 10.0) -> list[QueueMessage]:
        response = self.sqs.receive_message(
            QueueUrl=self.queue_url, MaxNumberOfMessages=min(max_messages, 10), WaitTimeSeconds=int(min(wait_seconds, 20))
        )
        return [
            QueueMessage(id=m["MessageId"], body=json.loads(m["Body"]), receipt=m["ReceiptHandle"]) for m in response.get("Messages", [])
        ]

    def ack(self, message: QueueMessage) -> None:
        self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=message.receipt)

    def nack(self, message: QueueMessage) -> None:
        self.sqs.change_message_visibility(QueueUrl=self.queue_url, ReceiptHandle=message.receipt, VisibilityTimeout=0)
