"""NTF-002 email notifications and NTF-003 Slack / Teams destinations."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import build_state
from app.db.models import Job, Notification
from app.jobs.core import Worker, notify
from app.main import create_app
from app.notify.channels import chat_payload, check_chat_url
from app.notify.email import ConsoleSender, Email, MemorySender, SMTPSender, email_sender
from app.webhooks import WebhookDispatcher, WebhookError

from .test_auth import PASSWORD, admin_headers, bearer, login


@pytest.fixture
def state(tmp_path):
    s = build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)
    s.extras["email_sender"] = MemorySender()
    return s


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def drain(state) -> int:
    return Worker(state, wait_seconds=0).drain()


def add_user(client, h, email, role="analyst"):
    r = client.post("/v1/tenant/users", json={"email": email, "role": role, "password": PASSWORD}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"], bearer(login(client, email).json()["access_token"])


def test_email_preferences_and_fan_out(client, state):
    h = admin_headers(client)
    assert client.get("/v1/notifications/preferences", headers=h).json() == {"email": []}
    assert client.put("/v1/notifications/preferences", json={"email": ["bogus"]}, headers=h).status_code == 422
    assert client.put("/v1/notifications/preferences", json={"email": ["model.registered", "job.failed"]}, headers=h).status_code == 200
    bob_id, bob = add_user(client, h, "bob@acme.example")
    client.put("/v1/notifications/preferences", json={"email": ["*"]}, headers=bob)
    outbox = state.extras["email_sender"].outbox

    notify(state, "acme", None, "model.registered", "churn v3 registered", {"version": 3})  # tenant-wide
    drain(state)
    assert sorted(e.to for e in outbox) == ["ada@acme.example", "bob@acme.example"]
    assert "churn v3 registered" in outbox[0].subject and "version: 3" in outbox[0].body

    outbox.clear()
    notify(state, "acme", bob_id, "job.succeeded", "done", {})  # only bob, and only because he opted in to everything
    drain(state)
    assert [e.to for e in outbox] == ["bob@acme.example"]

    outbox.clear()
    client.patch(f"/v1/tenant/users/{bob_id}", json={"disabled": True}, headers=h)
    notify(state, "acme", None, "endpoint.deployed", "deployed", {})  # ada didn't opt in; bob is disabled
    drain(state)
    assert outbox == []
    # delivery jobs never produce job.* notifications of their own
    with state.db.session("acme") as s:
        kinds = [n.kind for n in s.execute(select(Notification)).scalars()]
        assert kinds.count("job.succeeded") == 1  # only the one sent above
        assert {j.type for j in s.execute(select(Job)).scalars()} == {"notification.email"}


def test_preferences_require_a_user(client):
    h = admin_headers(client)
    key = client.post("/v1/tenant/api-keys", json={"name": "k", "role": "analyst"}, headers=h).json()["key"]
    assert client.get("/v1/notifications/preferences", headers={"X-API-Key": key}).status_code == 400


def test_smtp_sender_uses_starttls_before_login():
    calls = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            calls.append(("connect", host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            calls.append(("quit",))

        def ehlo(self):
            calls.append(("ehlo",))

        def starttls(self, context):
            assert context.verify_mode.name == "CERT_REQUIRED"
            calls.append(("starttls",))

        def login(self, user, password):
            calls.append(("login", user, password))

        def send_message(self, msg):
            calls.append(("send", msg["To"], msg["Subject"]))

    sender = SMTPSender("smtp.example", 587, "ap@example.com", username="ap", password="s3cret", smtp_class=FakeSMTP)
    sender.send(Email("to@example.com", "Hello", "Body"))
    names = [c[0] for c in calls]
    assert names.index("starttls") < names.index("login") < names.index("send")
    assert ("send", "to@example.com", "Hello") in calls
    assert "s3cret" not in repr(sender)


def test_sender_factory(tmp_path):
    s = build_state(data_dir=tmp_path, cloud_provider="local", database_url=None, inline_worker=False)
    assert isinstance(email_sender(s), ConsoleSender)
    s2 = build_state(data_dir=tmp_path / "b", cloud_provider="local", database_url=None, inline_worker=False, email_sender="smtp")
    with pytest.raises(RuntimeError):
        email_sender(s2)
    s3 = build_state(
        data_dir=tmp_path / "c", cloud_provider="local", database_url=None, inline_worker=False, email_sender="smtp", smtp_host="mx.example"
    )
    s3.secrets.put("platform", "smtp-password", "pw")
    assert isinstance(email_sender(s3), SMTPSender)


def test_chat_url_guard():
    with pytest.raises(WebhookError):
        check_chat_url("slack", "https://evil.example/hook")
    with pytest.raises(WebhookError):
        check_chat_url("teams", "https://hooks.slack.com/services/x")
    with pytest.raises(WebhookError):
        check_chat_url("slack", "http://hooks.slack.com/services/x", allow_private=True)
    assert chat_payload("teams", "job.failed", "T", {"a": 1})["@type"] == "MessageCard"
    assert chat_payload("slack", "job.failed", "T", {"a": 1})["text"] == "*T*"


def test_chat_destinations(client, state):
    received: list[httpx.Request] = []
    status = {"code": 200}

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(status["code"])

    state.extras["webhooks"] = WebhookDispatcher(state, allow_private=True, transport=httpx.MockTransport(handler))
    h = admin_headers(client)
    url = "https://hooks.slack.com/services/T000/B000/XXXX"
    r = client.post("/v1/tenant/chat-destinations", json={"kind": "slack", "name": "ops", "url": url, "events": ["job.failed"]}, headers=h)
    assert r.status_code == 201, r.text
    assert "url" not in r.json() and r.json()["host"] == "hooks.slack.com"
    assert url not in json.dumps(client.get("/v1/tenant/chat-destinations", headers=h).json())
    bad = {"kind": "slack", "name": "x", "url": url, "events": ["nope"]}
    assert client.post("/v1/tenant/chat-destinations", json=bad, headers=h).status_code == 422
    teams = {"kind": "teams", "name": "t", "url": "https://acme.webhook.office.com/webhookb2/x", "events": ["*"]}
    tid = client.post("/v1/tenant/chat-destinations", json=teams, headers=h).json()["id"]

    notify(state, "acme", None, "job.failed", "training.run failed", {"job_id": "job_1"})
    drain(state)
    assert sorted(str(r.url) for r in received) == sorted([url, teams["url"]])
    slack_body = json.loads(next(r for r in received if "slack" in str(r.url)).content)
    assert slack_body["text"] == "*training.run failed*" and "job_1" in json.dumps(slack_body)

    # failed chat deliveries are retried and never cause a notification loop
    received.clear()
    status["code"] = 500
    notify(state, "acme", None, "model.registered", "m", {})  # only the teams destination subscribes to "*"
    for _ in range(6):
        drain(state)
    assert len(received) == 5  # max_attempts
    with state.db.session("acme") as s:
        assert not [
            n
            for n in s.execute(select(Notification)).scalars()
            if n.kind == "job.failed" and n.body.get("type", "").startswith("notification.")
        ]
    assert client.delete(f"/v1/tenant/chat-destinations/{tid}", headers=h).status_code == 204
    assert state.secrets.get("acme", f"chat-{tid}") is None
    assert state.audit.entries("acme", "chat_destination.delete")
