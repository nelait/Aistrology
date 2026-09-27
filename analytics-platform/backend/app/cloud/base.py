"""Cloud-neutral interfaces. Every provider (local, GCP, AWS) implements all four.

No module outside ``app.cloud`` may import a cloud SDK.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path


class ObjectNotFound(LookupError):
    pass


class ObjectStore(ABC):
    """Blob storage: local disk, Google Cloud Storage or Amazon S3."""

    @abstractmethod
    def put_file(self, key: str, path: Path) -> None: ...

    @abstractmethod
    def put_bytes(self, key: str, data: bytes) -> None: ...

    @abstractmethod
    def get_bytes(self, key: str) -> bytes: ...

    @abstractmethod
    def download(self, key: str, path: Path) -> None: ...

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def list(self, prefix: str) -> Iterator[tuple[str, int]]:
        """Yield (key, size) for every object under ``prefix``."""

    @abstractmethod
    def delete(self, key: str) -> None: ...

    def delete_prefix(self, prefix: str) -> int:
        count = 0
        for key, _ in list(self.list(prefix)):
            self.delete(key)
            count += 1
        return count


class SecretStore(ABC):
    """Tenant-scoped secrets (BYOK LLM keys, connector credentials): local file, GCP Secret Manager, AWS Secrets Manager."""

    @abstractmethod
    def put(self, tenant_id: str, name: str, value: str) -> None: ...

    @abstractmethod
    def get(self, tenant_id: str, name: str) -> str | None: ...

    @abstractmethod
    def delete(self, tenant_id: str, name: str) -> None: ...

    @abstractmethod
    def names(self, tenant_id: str) -> list[str]: ...

    def delete_tenant(self, tenant_id: str) -> None:
        for name in self.names(tenant_id):
            self.delete(tenant_id, name)


class KeyManager(ABC):
    """Wraps and unwraps data-encryption keys with a master key held in the KMS.

    The tenant ID is bound to every wrapped key (GCP additional authenticated data,
    AWS encryption context), so a key wrapped for one tenant can't be unwrapped for another.
    """

    @abstractmethod
    def wrap(self, tenant_id: str, plaintext_key: bytes) -> bytes: ...

    @abstractmethod
    def unwrap(self, tenant_id: str, wrapped_key: bytes) -> bytes: ...


@dataclass(frozen=True)
class QueueMessage:
    id: str
    body: dict
    receipt: str  # provider handle used to ack/nack


class Queue(ABC):
    """At-least-once job queue: in-process, Google Pub/Sub or Amazon SQS."""

    @abstractmethod
    def publish(self, body: dict) -> str: ...

    @abstractmethod
    def receive(self, max_messages: int = 1, wait_seconds: float = 10.0) -> list[QueueMessage]: ...

    @abstractmethod
    def ack(self, message: QueueMessage) -> None: ...

    @abstractmethod
    def nack(self, message: QueueMessage) -> None:
        """Return the message to the queue for redelivery."""


@dataclass
class Cloud:
    provider: str
    objects: ObjectStore
    secrets: SecretStore
    kms: KeyManager
    queue: Queue
