"""Phase 3: dashboard comments (SHR-005), multi-dataset analytics (LLM-008) and personalized suggestions (LLM-009)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import build_state
from app.db.models import Notification
from app.llm.providers.mock import MockProvider
from app.llm.router import LLMRouter
from app.main import create_app

from .test_auth import PASSWORD, admin_headers, bearer, login

ORDERS = "order_id,customer_id,amount\n" + "\n".join(f"{i},{i % 5 + 1},{i * 10}" for i in range(1, 31))
CUSTOMERS = "id,segment,country\n" + "\n".join(f"{i},{'smb' if i % 2 else 'enterprise'},{'DE' if i < 3 else 'US'}" for i in range(1, 6))


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def add_user(client, h, email, role="analyst"):
    r = client.post("/v1/tenant/users", json={"email": email, "role": role, "password": PASSWORD}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"], bearer(login(client, email).json()["access_token"])


def upload(client, h, name, content) -> str:
    r = client.post("/v1/datasets", files={"file": (name, content.encode(), "text/csv")}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["dataset"]["id"]


# -- SHR-005 comments --------------------------------------------------------------------------------------------


def test_comments_threads_mentions_and_permissions(client, state):
    h = admin_headers(client)
    spec = {"pages": [{"id": "p", "title": "P", "widgets": [{"id": "w1", "type": "text", "config": {}}]}]}
    dash = client.post("/v1/dashboards", json={"name": "Ops", "spec": spec}, headers=h).json()
    bob, bob_h = add_user(client, h, "bob@acme.example")
    carol, carol_h = add_user(client, h, "carol@acme.example")
    dave, _ = add_user(client, h, "dave@acme.example")
    base = f"/v1/dashboards/{dash['id']}/comments"

    # bob can't see the dashboard yet, so he can't read or post comments
    assert client.get(base, headers=bob_h).status_code == 404
    client.post(f"/v1/dashboards/{dash['id']}/share", json={"user_id": bob, "role": "viewer"}, headers=h)
    client.post(f"/v1/dashboards/{dash['id']}/share", json={"user_id": carol, "role": "viewer"}, headers=h)

    # mentions notify only users who can see the dashboard (dave can't); unknown ids are ignored
    r = client.post(base, json={"body": f"@{bob} please check, cc @{dave} @usr_ghost", "widget_id": "w1"}, headers=h)
    assert r.status_code == 201, r.text
    root = r.json()
    assert root["mentions"] == [bob] and root["widget_id"] == "w1"
    with state.db.session("acme") as s:
        notes = [n for n in s.execute(select(Notification).where(Notification.kind == "comment.mention")).scalars()]
        assert [n.user_id for n in notes] == [bob] and "please" not in str(notes[0].body)  # no comment text in notifications

    assert client.post(base, json={"body": "x", "widget_id": "nope"}, headers=h).status_code == 422
    assert client.post(base, json={"body": "x" * 5001}, headers=h).status_code == 422
    reply = client.post(base, json={"body": "on it", "parent_id": root["id"]}, headers=bob_h).json()
    nested = client.post(base, json={"body": "thanks", "parent_id": reply["id"]}, headers=carol_h).json()
    assert nested["parent_id"] == root["id"] and nested["widget_id"] == "w1"  # threads are one level deep

    threads = client.get(base, headers=carol_h).json()
    assert len(threads) == 1 and [c["body"] for c in threads[0]["replies"]] == ["on it", "thanks"]
    assert client.get(base, params={"widget_id": "other"}, headers=carol_h).json() == []

    # edit own only; the edit notifies newly mentioned users
    assert client.patch(f"{base}/{reply['id']}", json={"body": "hijack"}, headers=carol_h).status_code == 403
    r = client.patch(f"{base}/{reply['id']}", json={"body": f"done, @{carol}"}, headers=bob_h)
    assert r.status_code == 200 and r.json()["edited_at"] and r.json()["mentions"] == [carol]
    with state.db.session("acme") as s:
        assert s.execute(select(Notification).where(Notification.kind == "comment.mention", Notification.user_id == carol)).first()

    # resolve: a viewer who isn't the author can't; the owner (admin) can
    assert client.patch(f"{base}/{root['id']}", json={"resolved": True}, headers=carol_h).status_code == 403
    assert client.patch(f"{base}/{root['id']}", json={"resolved": True}, headers=h).json()["resolved"] is True
    assert client.get(base, params={"include_resolved": False}, headers=h).json() == []

    # delete: own or admin
    assert client.delete(f"{base}/{nested['id']}", headers=bob_h).status_code == 403
    assert client.delete(f"{base}/{nested['id']}", headers=carol_h).status_code == 204
    assert client.delete(f"{base}/{root['id']}", headers=h).status_code == 204  # admin; removes the thread
    assert client.get(base, headers=h).json() == []
    assert state.audit.entries("acme", "dashboard.comment.delete")

    # another tenant can't reach the comments
    other = admin_headers(client, "globex", "gus@globex.example")
    assert client.get(base, headers=other).status_code == 404


# -- LLM-008 multi-dataset analytics -----------------------------------------------------------------------------


def test_multi_dataset_query_and_join_suggestions(client, state):
    h = admin_headers(client)
    orders = upload(client, h, "orders.csv", ORDERS)
    customers = upload(client, h, "customers.csv", CUSTOMERS)
    sql = "SELECT c.segment, sum(o.amount) AS total FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY 1 ORDER BY 1"
    r = client.post("/v1/analytics/query", json={"datasets": {"orders": orders, "customers": customers}, "sql": sql}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["columns"] == ["segment", "total"] and len(r.json()["rows"]) == 2

    bad = {"datasets": {"orders": orders}, "sql": "SELECT * FROM read_csv('/etc/passwd')"}
    assert client.post("/v1/analytics/query", json=bad, headers=h).status_code == 400
    assert (
        client.post("/v1/analytics/query", json={"datasets": {"orders": orders}, "sql": "DROP TABLE orders"}, headers=h).status_code == 400
    )
    assert client.post("/v1/analytics/query", json={"datasets": {"Bad-Alias": orders}, "sql": "SELECT 1"}, headers=h).status_code == 422
    assert client.post("/v1/analytics/query", json={"datasets": {"select": orders}, "sql": "SELECT 1"}, headers=h).status_code == 422
    # datasets from another tenant are invisible
    other = admin_headers(client, "globex", "gus@globex.example")
    r = client.post("/v1/analytics/query", json={"datasets": {"orders": orders}, "sql": "SELECT 1"}, headers=other)
    assert r.status_code == 404

    r = client.post("/v1/analytics/suggestions", json={"datasets": {"orders": orders, "customers": customers}}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    top = body["join_candidates"][0]
    assert (top["left_table"], top["left_column"], top["right_table"], top["right_column"]) == ("orders", "customer_id", "customers", "id")
    assert top["containment"] == 1.0
    suggestions = body["suggestions"]
    assert suggestions and all(s["valid"] for s in suggestions), suggestions
    assert any("JOIN" in s["sql"] and "customer_id" in s["sql"] for s in suggestions)
    assert client.post("/v1/analytics/suggestions", json={"datasets": {"orders": orders}}, headers=h).status_code == 422  # needs 2+


def test_demo_join_suggestion_without_candidates():
    import json

    from app.llm.base import LLMRequest, Message
    from app.llm.providers.demo import demo_response

    payload = {
        "datasets": [
            {"table": "orders", "columns": [{"name": "customer_id", "type": "integer"}, {"name": "amount", "role": "continuous"}]},
            {"table": "customers", "columns": [{"name": "id", "type": "integer"}, {"name": "segment", "role": "categorical"}]},
        ],
        "join_candidates": [],
    }
    req = LLMRequest(
        messages=[Message(role="user", content=f"<datasets>\n{json.dumps(payload)}\n</datasets>")], task="analytics.suggest_joins"
    )
    out = json.loads(demo_response(req))["suggestions"]
    assert 'ON l."customer_id" = r."id"' in out[0]["sql"] and "segment" in out[1]["sql"]


# -- LLM-009 personalization -------------------------------------------------------------------------------------


def test_feedback_personalizes_prompt_and_ranking(client, state):
    h = admin_headers(client)
    ds = upload(client, h, "sales.csv", "id,region,amount\n" + "\n".join(f"{i},{'ew'[i % 2]},{i}" for i in range(1, 41)))
    mock = MockProvider()
    state.router_overrides["acme"] = LLMRouter("acme", [mock], ledger=state.ledger, audit=state.audit)

    first = client.post(f"/v1/datasets/{ds}/suggestions", headers=h)
    assert first.status_code == 200, first.text
    assert "<preferences>" not in mock.calls[-1].messages[0].content  # nothing learned yet

    fb = f"/v1/datasets/{ds}/suggestions/feedback"
    for _ in range(3):
        assert (
            client.post(
                fb, json={"accepted": True, "suggestion": {"chart_type": "histogram", "category": "descriptive"}}, headers=h
            ).status_code
            == 200
        )
        client.post(fb, json={"accepted": False, "suggestion": {"chart_type": "kpi", "category": "descriptive"}}, headers=h)
    assert (
        client.post(fb, json={"accepted": True, "suggestion": {"chart_type": "nope", "category": "descriptive"}}, headers=h).status_code
        == 422
    )
    prefs = client.get("/v1/suggestions/preferences", headers=h).json()
    assert prefs["preferences"]["chart_type"]["histogram"] == {"accepted": 3, "rejected": 0}
    assert "histogram" in prefs["summary"] and "kpi" in prefs["summary"]

    ranked = client.post(f"/v1/datasets/{ds}/suggestions", headers=h).json()
    prompt = mock.calls[-1].messages[0].content
    assert "<preferences>" in prompt and "histogram" in prompt.split("<preferences>")[1]
    assert ranked[0]["chart_type"] == "histogram" and ranked[-1]["chart_type"] == "kpi"
    assert [s["chart_type"] for s in first.json()][0] == "kpi"  # the unpersonalized order started with the KPI

    # tenant-scoped: another tenant starts from nothing
    other = admin_headers(client, "globex", "gus@globex.example")
    assert client.get("/v1/suggestions/preferences", headers=other).json()["summary"] is None
    _, analyst = add_user(client, h, "ann@acme.example")
    assert client.delete("/v1/suggestions/preferences", headers=analyst).status_code == 403
    assert client.delete("/v1/suggestions/preferences", headers=h).status_code == 204
    assert client.get("/v1/suggestions/preferences", headers=h).json()["preferences"] == {"chart_type": {}, "category": {}}
