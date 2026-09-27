"""Phase 3 scheduler: cron evaluation, atomic claiming, quotas, the /v1/schedules API, and scheduled deliveries
(USR-007 analytics, SHR-004 dashboard snapshots, API-011 drift checks)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import build_state
from app.db.models import Job, Schedule, Tenant
from app.jobs.core import Worker
from app.jobs.cron import CronError, parse_cron
from app.jobs.scheduler import Scheduler
from app.main import create_app
from app.notify.email import MemorySender
from app.webhooks import WebhookDispatcher

from .test_auth import PASSWORD, admin_headers, bearer, login

CSV = "id,region,amount\n" + "\n".join(f"{i},{'ew'[i % 2]},{i}" for i in range(1, 21))


# -- cron --------------------------------------------------------------------------------------------------------


def test_cron_basics():
    c = parse_cron("*/15 * * * *")
    assert c.next_after(datetime(2026, 1, 1, 10, 7, tzinfo=UTC)) == datetime(2026, 1, 1, 10, 15, tzinfo=UTC)
    assert c.next_after(datetime(2026, 1, 1, 10, 15, tzinfo=UTC)) == datetime(2026, 1, 1, 10, 30, tzinfo=UTC)  # strictly after
    weekdays = parse_cron("0 9 * * mon-fri", "America/New_York")
    # Saturday 2026-01-03 → Monday 2026-01-05 09:00 EST = 14:00 UTC
    assert weekdays.next_after(datetime(2026, 1, 3, 12, tzinfo=UTC)) == datetime(2026, 1, 5, 14, tzinfo=UTC)
    # day-of-month OR day-of-week when both are restricted (Vixie semantics)
    either = parse_cron("0 0 1 * sun")
    assert either.next_after(datetime(2026, 1, 1, 1, tzinfo=UTC)) == datetime(2026, 1, 4, tzinfo=UTC)  # Sunday Jan 4
    assert parse_cron("0 0 * jan,jul 7").next_after(datetime(2026, 1, 1, tzinfo=UTC)).weekday() == 6
    assert parse_cron("30 6 1 */3 *").upcoming(datetime(2026, 2, 1, tzinfo=UTC), 2)[1] == datetime(2026, 7, 1, 6, 30, tzinfo=UTC)
    for bad in ("* * * *", "60 * * * *", "* * * * mon-sun-x", "*/0 * * * *", "5-1 * * * *", "0 0 30 2 *"):
        with pytest.raises(CronError):
            parse_cron(bad)
    with pytest.raises(CronError):
        parse_cron("0 * * * *", "Mars/Olympus")
    assert parse_cron("*/5 * * * *").min_interval_minutes() == 5
    assert parse_cron("0,2 * * * *").min_interval_minutes() == 2
    assert parse_cron("0 23 * * *").min_interval_minutes() == 1440


def test_cron_dst():
    berlin = parse_cron("30 2 * * *", "Europe/Berlin")
    # 2026-03-29: clocks jump 02:00 → 03:00 in Berlin, so 02:30 doesn't exist that day.
    runs = berlin.upcoming(datetime(2026, 3, 28, 12, tzinfo=UTC), 2)
    assert runs == [datetime(2026, 3, 30, 0, 30, tzinfo=UTC), datetime(2026, 3, 31, 0, 30, tzinfo=UTC)]
    # 2026-10-25: 02:30 happens twice; it runs once (the first, CEST = 00:30 UTC).
    runs = berlin.upcoming(datetime(2026, 10, 24, 12, tzinfo=UTC), 2)
    assert runs == [datetime(2026, 10, 25, 0, 30, tzinfo=UTC), datetime(2026, 10, 26, 1, 30, tzinfo=UTC)]


# -- fixtures ------------------------------------------------------------------------------------------------------


@pytest.fixture
def state(tmp_path):
    s = build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)
    s.extras["email_sender"] = MemorySender()
    return s


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


@pytest.fixture
def chat(state):
    received: list[httpx.Request] = []
    state.extras["webhooks"] = WebhookDispatcher(
        state, allow_private=True, transport=httpx.MockTransport(lambda r: received.append(r) or httpx.Response(200))
    )
    return received


def drain(state) -> int:
    return Worker(state, wait_seconds=0).drain()


def me(client, h) -> str:
    return client.get("/v1/auth/me", headers=h).json()["id"]


def add_user(client, h, email, role="analyst"):
    r = client.post("/v1/tenant/users", json={"email": email, "role": role, "password": PASSWORD}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"], bearer(login(client, email).json()["access_token"])


def dataset(client, h) -> str:
    r = client.post("/v1/datasets", files={"file": ("sales.csv", CSV.encode(), "text/csv")}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["dataset"]["id"]


def destination(client, h) -> str:
    body = {"kind": "slack", "name": "ops", "url": "https://hooks.slack.com/services/T0/B0/X", "events": ["job.failed"]}
    r = client.post("/v1/tenant/chat-destinations", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def make_due(state, schedule_id, when=None):
    with state.db.session("acme") as s:
        s.get(Schedule, schedule_id).next_run_at = when or datetime.now(UTC) - timedelta(minutes=1)


# -- scheduler core -------------------------------------------------------------------------------------------------


def test_schedule_api_validation(client, state):
    h = admin_headers(client)
    ds = dataset(client, h)
    base = {"name": "p", "cron": "0 6 * * *", "timezone": "Europe/Berlin", "job_type": "dataset.profile", "params": {"dataset_id": ds}}
    types = client.get("/v1/schedules/types", headers=h).json()
    assert {t["job_type"] for t in types} >= {
        "analytics.scheduled_run",
        "dashboard.deliver",
        "serving.drift_check",
        "stream.compact",
        "serving.canary_step",
    }
    assert client.post("/v1/schedules", json={**base, "job_type": "tenant.export"}, headers=h).status_code == 422  # not allowlisted
    assert client.post("/v1/schedules", json={**base, "cron": "*/2 * * * *"}, headers=h).status_code == 422  # below 5 minutes
    assert client.post("/v1/schedules", json={**base, "timezone": "Nowhere/City"}, headers=h).status_code == 422
    assert client.post("/v1/schedules", json={**base, "params": {"dataset_id": "ds_" + "0" * 32}}, headers=h).status_code == 422
    r = client.post("/v1/schedules", json=base, headers=h)
    assert r.status_code == 201, r.text
    sched = r.json()
    assert sched["next_run_at"] and len(sched["upcoming"]) == 5 and sched["params"] == {"dataset_id": ds}
    assert datetime.fromisoformat(sched["upcoming"][0].replace("Z", "+00:00")).astimezone(UTC).hour in (4, 5)  # 06:00 Berlin

    # a viewer can't schedule; an analyst can't schedule drift checks (needs endpoints.deploy)
    _, viewer = add_user(client, h, "vic@acme.example", "viewer")
    assert client.post("/v1/schedules", json={**base, "cron": "0 7 * * *"}, headers=viewer).status_code in (403, 422)
    _, analyst = add_user(client, h, "ann@acme.example", "analyst")
    drift = {**base, "job_type": "serving.drift_check", "params": {}}
    assert client.post("/v1/schedules", json=drift, headers=analyst).status_code == 403
    # others' schedules are invisible to non-admins
    assert client.get(f"/v1/schedules/{sched['id']}", headers=analyst).status_code == 404
    assert client.get("/v1/schedules", headers=analyst).json() == []
    assert [s["id"] for s in client.get("/v1/schedules", headers=h).json()] == [sched["id"]]

    r = client.patch(f"/v1/schedules/{sched['id']}", json={"cron": "15 6 * * *", "enabled": False}, headers=h)
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["next_run_at"] is None
    assert client.patch(f"/v1/schedules/{sched['id']}", json={"cron": "* * * * *"}, headers=h).status_code == 422
    assert client.delete(f"/v1/schedules/{sched['id']}", headers=h).status_code == 204
    assert client.get(f"/v1/schedules/{sched['id']}", headers=h).status_code == 404
    assert [e.action for e in state.audit.entries("acme") if e.action.startswith("schedule.")] == [
        "schedule.create",
        "schedule.update",
        "schedule.delete",
    ]


def test_tick_claims_once_and_advances(client, state):
    h = admin_headers(client)
    ds = dataset(client, h)
    body = {"name": "p", "cron": "*/5 * * * *", "job_type": "dataset.profile", "params": {"dataset_id": ds}}
    sid = client.post("/v1/schedules", json=body, headers=h).json()["id"]
    now = datetime.now(UTC)
    make_due(state, sid, now - timedelta(minutes=1))

    # Two replicas read the same due row; only the conditional UPDATE of the first matches.
    with state.db.session("acme") as s:
        due_at = s.get(Schedule, sid).next_run_at
    a, b = Scheduler(state), Scheduler(state)
    nxt = parse_cron("*/5 * * * *").next_after(now)
    assert a._claim(sid, "acme", due_at, nxt, now) is True
    assert b._claim(sid, "acme", due_at, nxt, now) is False

    make_due(state, sid, now - timedelta(minutes=1))
    first = a.tick(now)
    assert [o["status"] for o in first] == ["submitted"]
    assert b.tick(now) == []  # already advanced
    with state.db.session("acme") as s:
        sched = s.get(Schedule, sid)
        assert sched.next_run_at.replace(tzinfo=UTC) > now and sched.last_job_id == first[0]["job_id"]
        job = s.get(Job, first[0]["job_id"])
        assert job.params["schedule_id"] == sid and job.created_by == me(client, h)
    drain(state)
    assert client.get(f"/v1/jobs/{first[0]['job_id']}", headers=h).json()["status"] == "succeeded"

    # the worker loop ticks too
    make_due(state, sid, now - timedelta(minutes=1))
    worker = Worker(state, wait_seconds=0, scheduler=Scheduler(state), scheduler_interval=0)
    worker.run_once()
    with state.db.session("acme") as s:
        assert len(s.execute(select(Job).where(Job.type == "dataset.profile")).scalars().all()) == 2


def test_quota_skip_and_owner_revalidation(client, state):
    h = admin_headers(client)
    ds = dataset(client, h)
    uid, analyst = add_user(client, h, "ann@acme.example", "analyst")
    body = {"name": "p", "cron": "0 * * * *", "job_type": "dataset.profile", "params": {"dataset_id": ds}}
    sid = client.post("/v1/schedules", json=body, headers=analyst).json()["id"]
    with state.db.session("acme") as s:
        s.get(Tenant, "acme").quotas = {"max_concurrent_jobs": 0}
    make_due(state, sid)
    [outcome] = Scheduler(state).tick()
    assert outcome["status"] == "skipped" and "limit" in outcome["error"]
    got = client.get(f"/v1/schedules/{sid}", headers=analyst).json()
    assert got["last_status"] == "skipped" and datetime.fromisoformat(got["next_run_at"].replace("Z", "+00:00")) > datetime.now(UTC)
    assert state.audit.entries("acme", "schedule.skipped")
    # run now hits the quota too → 429
    assert client.post(f"/v1/schedules/{sid}/run", headers=analyst).status_code == 429
    with state.db.session("acme") as s:
        s.get(Tenant, "acme").quotas = {}
    assert client.post(f"/v1/schedules/{sid}/run", headers=analyst).status_code == 202

    # the owner is demoted to viewer: runs are skipped (the schedule doesn't outlive the permission)
    client.patch(f"/v1/tenant/users/{uid}", json={"role": "viewer"}, headers=h)
    make_due(state, sid)
    [outcome] = Scheduler(state).tick()
    assert outcome["status"] == "skipped" and "owner" in outcome["error"]


# -- USR-007 scheduled analytics -------------------------------------------------------------------------------


def test_scheduled_analytic_delivers_csv_and_chat(client, state, chat):
    h = admin_headers(client)
    ds = dataset(client, h)
    ada = me(client, h)
    bob, _ = add_user(client, h, "bob@acme.example")
    dest = destination(client, h)
    analytic = client.post(
        "/v1/analytics",
        json={
            "dataset_id": ds,
            "name": "Sales by region",
            "sql": "SELECT region, sum(amount) AS total FROM data WHERE amount >= :min GROUP BY 1 ORDER BY 1",
            "parameters": [{"name": "min", "type": "number"}],
        },
        headers=h,
    ).json()
    params = {"analytic_id": analytic["id"], "params": {"min": 5}, "recipients": [ada, bob], "chat_destinations": [dest]}
    body = {
        "name": "daily sales",
        "cron": "0 8 * * *",
        "timezone": "Europe/London",
        "job_type": "analytics.scheduled_run",
        "params": params,
    }
    bad = {**body, "params": {**params, "params": {}}}
    assert client.post("/v1/schedules", json=bad, headers=h).status_code == 422  # :min needs a value
    assert client.post("/v1/schedules", json={**body, "params": {**params, "recipients": ["usr_nobody"]}}, headers=h).status_code == 422
    assert client.post("/v1/schedules", json={**body, "params": {**params, "chat_destinations": ["cd_x"]}}, headers=h).status_code == 422
    sid = client.post("/v1/schedules", json=body, headers=h).json()["id"]

    make_due(state, sid)
    [outcome] = Scheduler(state).tick()
    assert outcome["status"] == "submitted"
    drain(state)
    job = client.get(f"/v1/jobs/{outcome['job_id']}", headers=h).json()
    assert job["status"] == "succeeded", job
    assert job["result"]["emails_queued"] == 2 and job["result"]["chat_posts_queued"] == 1

    outbox = state.extras["email_sender"].outbox
    assert sorted(e.to for e in outbox) == ["ada@acme.example", "bob@acme.example"]
    [attachment] = outbox[0].attachments
    assert attachment.filename.endswith(".csv") and attachment.content_type == "text/csv"
    assert attachment.content.decode().splitlines()[0] == "region,total"
    assert "Sales by region" in outbox[0].subject
    [post] = chat
    assert "Sales by region" in json.dumps(json.loads(post.content))

    snapshot = client.get(f"/v1/schedules/{sid}", headers=h).json()["last_result"]
    assert snapshot["columns"] == ["region", "total"] and snapshot["row_count"] == 2 and snapshot["job_id"] == outcome["job_id"]
    # delivery jobs don't emit job.* notifications of their own
    with state.db.session("acme") as s:
        assert not [j for j in s.execute(select(Job)).scalars() if j.type == "notification.email"]


def test_scheduled_jobs_require_a_schedule(client, state):
    from app.jobs.core import JobService

    admin_headers(client)
    job = JobService(state).submit("acme", "analytics.scheduled_run", {"analytic_id": "x"}, "someone")
    drain(state)
    with state.db.session("acme") as s:
        row = s.get(Job, job.id)
        assert row.status == "failed" and "schedule" in row.error


# -- SHR-004 dashboard snapshots -----------------------------------------------------------------------------------


def test_scheduled_dashboard_delivery(client, state, chat):
    h = admin_headers(client)
    ds = dataset(client, h)
    ada = me(client, h)
    dest = destination(client, h)
    spec = {"pages": [{"id": "p", "title": "P", "widgets": [{"id": "t1", "type": "table", "title": "Rows", "config": {"dataset_id": ds}}]}]}
    dash = client.post("/v1/dashboards", json={"name": "Weekly KPIs", "spec": spec}, headers=h).json()
    _, bob_h = add_user(client, h, "bob@acme.example")
    bob = me(client, bob_h)
    params = {"dashboard_id": dash["id"], "recipients": [ada], "chat_destinations": [dest]}
    body = {"name": "weekly", "cron": "0 9 * * mon", "job_type": "dashboard.deliver", "params": params}
    # bob can't see the (unshared) dashboard, so he can't be a recipient
    assert client.post("/v1/schedules", json={**body, "params": {**params, "recipients": [bob]}}, headers=h).status_code == 422
    sid = client.post("/v1/schedules", json=body, headers=h).json()["id"]
    r = client.post(f"/v1/schedules/{sid}/run", headers=h)
    assert r.status_code == 202 and r.json()["status"] == "submitted"
    drain(state)
    job = client.get(f"/v1/jobs/{r.json()['job_id']}", headers=h).json()
    assert job["status"] == "succeeded" and job["result"]["link_kind"] == "public"
    [mail] = state.extras["email_sender"].outbox
    [attachment] = mail.attachments
    assert attachment.content_type == "text/html" and b"Weekly KPIs" in attachment.content
    [post] = chat
    link = json.loads(post.content)["blocks"][0]["text"]["text"]
    token = link.split("/v1/public/")[1].split()[0]
    assert client.get(f"/v1/public/{token}").status_code == 200  # a working short-lived public link

    # public links disabled → just the dashboard URL
    chat.clear()
    client.put("/v1/tenant/sharing", json={"public_links_enabled": False}, headers=h)
    r = client.post(f"/v1/schedules/{sid}/run", headers=h)
    drain(state)
    assert client.get(f"/v1/jobs/{r.json()['job_id']}", headers=h).json()["result"]["link_kind"] == "app"
    assert f"/dashboards/{dash['id']}" in json.loads(chat[0].content)["blocks"][0]["text"]["text"]


def test_drift_checks_are_schedulable(client, state):
    h = admin_headers(client)
    body = {"name": "drift", "cron": "0 */6 * * *", "job_type": "serving.drift_check", "params": {"hours": 12}}
    assert client.post("/v1/schedules", json={**body, "params": {"endpoint": "nope"}}, headers=h).status_code == 422
    sid = client.post("/v1/schedules", json=body, headers=h).json()["id"]
    r = client.post(f"/v1/schedules/{sid}/run", headers=h)
    drain(state)
    job = client.get(f"/v1/jobs/{r.json()['job_id']}", headers=h).json()
    assert job["type"] == "serving.drift_check" and job["status"] == "succeeded" and job["params"]["hours"] == 12


def test_canary_steps_are_schedulable(client, state):
    """API-009 canary evaluation runs from the scheduler instead of per-process timers."""
    h = admin_headers(client)
    base = {"name": "canary", "cron": "*/5 * * * *"}
    ok = client.post("/v1/schedules", json={**base, "job_type": "serving.canary_step", "params": {}}, headers=h)
    assert ok.status_code == 201, ok.text
    bad = client.post("/v1/schedules", json={**base, "name": "c2", "job_type": "serving.canary_step", "params": {"x": 1}}, headers=h)
    assert bad.status_code == 422
