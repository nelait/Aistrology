from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from botocore.exceptions import ClientError
from google.api_core.exceptions import AlreadyExists, NotFound
from moto import mock_aws

from app.cloud import crypto
from app.cloud.aws import AWSKeyManager, AWSSecretStore, S3ObjectStore, SQSQueue
from app.cloud.base import ObjectNotFound
from app.cloud.crypto import DecryptionError, EncryptedObjectStore, TenantKeyring, TenantKeyShredded, decrypt_stream, encrypt_stream
from app.cloud.factory import CloudConfigError, build_cloud
from app.cloud.gcp import GCPKeyManager, GCPSecretStore, GCSObjectStore, PubSubQueue
from app.cloud.local import InMemoryQueue, LocalKeyManager, LocalObjectStore, LocalSecretStore
from app.config import Settings

# ---------------------------------------------------------------- crypto


@pytest.fixture
def small_chunks(monkeypatch):
    monkeypatch.setattr(crypto, "CHUNK", 1000)


@pytest.mark.parametrize("size", [0, 1, 999, 1000, 1001, 5000, 12345])
def test_stream_roundtrip_many_chunk_sizes(small_chunks, size):
    dek = os.urandom(32)
    data = os.urandom(size)
    pieces = [data[i : i + 777] for i in range(0, len(data), 777)] or [b""]
    ct = b"".join(encrypt_stream(dek, "k", iter(pieces)))
    # decrypt with arbitrarily split input
    splits = [ct[i : i + 333] for i in range(0, len(ct), 333)]
    assert b"".join(decrypt_stream(dek, "k", iter(splits))) == data


def test_tamper_truncation_and_key_binding(small_chunks):
    dek = os.urandom(32)
    ct = bytearray(b"".join(encrypt_stream(dek, "tenants/a/x", iter([os.urandom(3500)]))))
    good = bytes(ct)
    ct[50] ^= 1
    with pytest.raises(DecryptionError):
        b"".join(decrypt_stream(dek, "tenants/a/x", iter([bytes(ct)])))
    # drop the last frame (truncation) → previous frame was not sealed as final
    frames, pos = [], 12
    while pos < len(good):
        n = int.from_bytes(good[pos : pos + 4], "big")
        frames.append(good[pos : pos + 4 + n])
        pos += 4 + n
    truncated = good[:12] + b"".join(frames[:-1])
    with pytest.raises(DecryptionError):
        b"".join(decrypt_stream(dek, "tenants/a/x", iter([truncated])))
    with pytest.raises(DecryptionError):  # moved to another object key
        b"".join(decrypt_stream(dek, "tenants/a/y", iter([good])))
    with pytest.raises(DecryptionError):
        b"".join(decrypt_stream(os.urandom(32), "tenants/a/x", iter([good])))


def test_encrypted_store_and_crypto_shredding(tmp_path, small_chunks):
    objects = LocalObjectStore(tmp_path / "objects")
    store = EncryptedObjectStore(objects, TenantKeyring(objects, LocalKeyManager(tmp_path / "master.key")))
    src = tmp_path / "in.bin"
    src.write_bytes(os.urandom(4321))
    store.put_file("acme", "datasets/d1/raw/f.csv", src, tmp_path / "scratch" / "x")
    raw = objects.get_bytes("tenants/acme/datasets/d1/raw/f.csv")
    assert raw.startswith(b"APE1") and src.read_bytes() not in raw  # ciphertext at rest
    out = tmp_path / "out.bin"
    store.download("acme", "datasets/d1/raw/f.csv", out)
    assert out.read_bytes() == src.read_bytes()
    store.put_bytes("acme", "meta.json", b'{"a":1}')
    assert store.get_bytes("acme", "meta.json") == b'{"a":1}'
    assert sorted(k for k, _ in store.list("acme")) == ["datasets/d1/raw/f.csv", "meta.json"]
    # another tenant's key can't read acme's objects even with raw bucket access
    objects.put_bytes("tenants/globex/stolen", raw)
    store.put_bytes("globex", "own", b"x")
    with pytest.raises(DecryptionError):
        store.get_bytes("globex", "stolen")
    # shredding: the key is gone; a copy of the ciphertext (e.g. in a backup) is useless
    backup = raw
    store.keyring.shred("acme")
    objects.put_bytes("tenants/acme/restored", backup)
    with pytest.raises(TenantKeyShredded):
        store.get_bytes("acme", "restored")
    with pytest.raises(ValueError):
        store.put_bytes("acme", "../globex/own", b"x")


def test_local_secrets_are_encrypted_and_tenant_scoped(tmp_path):
    kms = LocalKeyManager(tmp_path / "k")
    secrets = LocalSecretStore(tmp_path / "s.json", kms)
    secrets.put("acme", "openai", "sk-live-123")
    assert "sk-live-123" not in (tmp_path / "s.json").read_text()
    assert secrets.get("acme", "openai") == "sk-live-123"
    assert secrets.get("globex", "openai") is None
    assert secrets.names("acme") == ["openai"]
    secrets.delete_tenant("acme")
    assert secrets.names("acme") == []


def test_in_memory_queue_redelivers_on_nack():
    q = InMemoryQueue()
    q.publish({"job": 1})
    [m] = q.receive(wait_seconds=0)
    q.nack(m)
    [again] = q.receive(wait_seconds=0)
    assert again.body == {"job": 1}
    q.ack(again)
    assert q.receive(wait_seconds=0) == []


# ---------------------------------------------------------------- factory


def test_factory_validates_provider_config(tmp_path, monkeypatch):
    monkeypatch.setenv("AP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AP_CLOUD_PROVIDER", "gcp")
    with pytest.raises(CloudConfigError, match="AP_GCP_PROJECT"):
        build_cloud(Settings())
    monkeypatch.setenv("AP_CLOUD_PROVIDER", "aws")
    with pytest.raises(CloudConfigError, match="AP_OBJECT_BUCKET"):
        build_cloud(Settings())
    monkeypatch.setenv("AP_CLOUD_PROVIDER", "azure")
    with pytest.raises(CloudConfigError, match="unsupported"):
        build_cloud(Settings())


# ---------------------------------------------------------------- AWS (moto)


@pytest.fixture
def aws(monkeypatch):
    for k, v in {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_DEFAULT_REGION": "us-east-1"}.items():
        monkeypatch.setenv(k, v)
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="ap-data")
        kms = boto3.client("kms", region_name="us-east-1")
        key_id = kms.create_key()["KeyMetadata"]["KeyId"]
        sqs = boto3.client("sqs", region_name="us-east-1")
        url = sqs.create_queue(QueueName="ap-jobs")["QueueUrl"]
        yield SimpleNamespace(key_id=key_id, queue_url=url)


def test_aws_factory_builds_everything(aws, tmp_path, monkeypatch):
    for k, v in {
        "AP_CLOUD_PROVIDER": "aws",
        "AP_DATA_DIR": str(tmp_path),
        "AP_OBJECT_BUCKET": "ap-data",
        "AP_AWS_KMS_KEY_ID": aws.key_id,
        "AP_AWS_SQS_QUEUE_URL": aws.queue_url,
    }.items():
        monkeypatch.setenv(k, v)
    cloud = build_cloud(Settings())
    assert cloud.provider == "aws"
    store = EncryptedObjectStore(cloud.objects, TenantKeyring(cloud.objects, cloud.kms))
    src = tmp_path / "f.csv"
    src.write_text("a,b\n1,2\n")
    store.put_file("acme", "datasets/x/raw/f.csv", src, tmp_path / "scratch" / "f")
    out = tmp_path / "back.csv"
    store.download("acme", "datasets/x/raw/f.csv", out)
    assert out.read_text() == "a,b\n1,2\n"
    assert store.delete_tenant("acme") == 1
    assert list(cloud.objects.list("tenants/acme/")) == []


def test_s3_object_store(aws, tmp_path):
    store = S3ObjectStore("ap-data", kms_key_id=aws.key_id)
    store.put_bytes("a/b.txt", b"hi")
    assert store.get_bytes("a/b.txt") == b"hi" and store.exists("a/b.txt") and not store.exists("a/c")
    with pytest.raises(ObjectNotFound):
        store.get_bytes("missing")
    with pytest.raises(ObjectNotFound):
        store.download("missing", tmp_path / "m")
    assert list(store.list("a/")) == [("a/b.txt", 2)]
    assert store.delete_prefix("a/") == 1 and not store.exists("a/b.txt")


def test_aws_kms_binds_tenant(aws):
    kms = AWSKeyManager(aws.key_id)
    wrapped = kms.wrap("acme", b"k" * 32)
    assert kms.unwrap("acme", wrapped) == b"k" * 32
    with pytest.raises(ClientError):  # encryption context (tenant) mismatch
        kms.unwrap("globex", wrapped)


def test_aws_secrets(aws):
    secrets = AWSSecretStore("analytics")
    secrets.put("acme", "openai", "v1")
    secrets.put("acme", "openai", "v2")
    assert secrets.get("acme", "openai") == "v2"
    assert secrets.get("globex", "openai") is None
    assert secrets.names("acme") == ["openai"]
    secrets.delete("acme", "openai")
    assert secrets.get("acme", "openai") is None


def test_sqs_queue(aws):
    q = SQSQueue(aws.queue_url)
    q.publish({"job_id": "j1"})
    [m] = q.receive(wait_seconds=0)
    assert m.body == {"job_id": "j1"}
    q.nack(m)
    [m2] = q.receive(wait_seconds=0)
    q.ack(m2)
    assert q.receive(wait_seconds=0) == []


# ---------------------------------------------------------------- GCP (fake SDK clients)


class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name

    @property
    def size(self):
        return len(self.bucket.data[self.name])

    def upload_from_filename(self, path):
        self.bucket.data[self.name] = Path(path).read_bytes()

    def upload_from_string(self, data):
        self.bucket.data[self.name] = data

    def download_as_bytes(self):
        if self.name not in self.bucket.data:
            raise NotFound("x")
        return self.bucket.data[self.name]

    def download_to_filename(self, path):
        Path(path).write_bytes(self.download_as_bytes())

    def exists(self):
        return self.name in self.bucket.data

    def delete(self):
        if self.name not in self.bucket.data:
            raise NotFound("x")
        del self.bucket.data[self.name]


class FakeBucket:
    def __init__(self):
        self.data: dict[str, bytes] = {}

    def blob(self, name):
        return FakeBlob(self, name)


class FakeStorageClient:
    def __init__(self):
        self._bucket = FakeBucket()

    def bucket(self, name):
        return self._bucket

    def list_blobs(self, bucket, prefix):
        return [FakeBlob(bucket, k) for k in sorted(bucket.data) if k.startswith(prefix)]


class FakeSecretManager:
    def __init__(self):
        self.secrets: dict[str, dict] = {}

    def create_secret(self, request):
        name = f"{request['parent']}/secrets/{request['secret_id']}"
        if name in self.secrets:
            raise AlreadyExists("x")
        self.secrets[name] = {"labels": request["secret"]["labels"], "versions": []}

    def add_secret_version(self, request):
        self.secrets[request["parent"]]["versions"].append(request["payload"]["data"])

    def access_secret_version(self, request):
        name = request["name"].rsplit("/versions/", 1)[0]
        if name not in self.secrets:
            raise NotFound("x")
        return SimpleNamespace(payload=SimpleNamespace(data=self.secrets[name]["versions"][-1]))

    def delete_secret(self, request):
        if request["name"] not in self.secrets:
            raise NotFound("x")
        del self.secrets[request["name"]]

    def list_secrets(self, request):
        tenant = request["filter"].split("=", 1)[1]
        return [SimpleNamespace(name=n) for n, s in self.secrets.items() if s["labels"]["tenant"] == tenant]


class FakeKMS:
    def encrypt(self, request):
        return SimpleNamespace(ciphertext=json.dumps([request["additional_authenticated_data"].hex(), request["plaintext"].hex()]).encode())

    def decrypt(self, request):
        aad, pt = json.loads(request["ciphertext"])
        if bytes.fromhex(aad) != request["additional_authenticated_data"]:
            raise ValueError("AAD mismatch")
        return SimpleNamespace(plaintext=bytes.fromhex(pt))


class FakePublisher:
    def __init__(self, sink):
        self.sink = sink

    def publish(self, topic, data):
        self.sink.append(data)
        return SimpleNamespace(result=lambda timeout: str(len(self.sink)))


class FakeSubscriber:
    def __init__(self, sink):
        self.sink = sink
        self.acked: list[str] = []
        self.nacked: list[str] = []

    def pull(self, request, timeout):
        msgs = [
            SimpleNamespace(ack_id=f"ack{i}", message=SimpleNamespace(message_id=str(i), data=d))
            for i, d in enumerate(self.sink[: request["max_messages"]])
        ]
        return SimpleNamespace(received_messages=msgs)

    def acknowledge(self, request):
        self.acked += request["ack_ids"]

    def modify_ack_deadline(self, request):
        self.nacked += request["ack_ids"]


def test_gcp_implementations(tmp_path):
    objects = GCSObjectStore("bucket", client=FakeStorageClient())
    kms = GCPKeyManager("projects/p/locations/l/keyRings/r/cryptoKeys/k", client=FakeKMS())
    store = EncryptedObjectStore(objects, TenantKeyring(objects, kms))
    store.put_bytes("acme", "x.json", b"{}")
    assert store.get_bytes("acme", "x.json") == b"{}"
    with pytest.raises(ObjectNotFound):
        objects.get_bytes("nope")
    with pytest.raises(ValueError):
        kms.unwrap("globex", kms.wrap("acme", b"k"))

    secrets = GCPSecretStore("proj", "analytics", client=FakeSecretManager())
    secrets.put("acme", "openai", "v1")
    secrets.put("acme", "openai", "v2")
    assert secrets.get("acme", "openai") == "v2" and secrets.get("globex", "openai") is None
    assert secrets.names("acme") == ["openai"]
    secrets.delete("acme", "openai")
    assert secrets.get("acme", "openai") is None

    sink: list[bytes] = []
    sub = FakeSubscriber(sink)
    q = PubSubQueue("projects/p/topics/t", "projects/p/subscriptions/s", publisher=FakePublisher(sink), subscriber=sub)
    q.publish({"job_id": "j1"})
    [m] = q.receive()
    assert m.body == {"job_id": "j1"}
    q.ack(m)
    q.nack(m)
    assert sub.acked == ["ack0"] and sub.nacked == ["ack0"]
