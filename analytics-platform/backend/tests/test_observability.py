from __future__ import annotations

import json
import logging

from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.main import create_app
from app.observability import JsonFormatter


def test_request_ids_metrics_and_json_logs(tmp_path, caplog):
    client = TestClient(
        create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False))
    )
    r = client.get("/v1/datasets", headers={"X-Tenant-ID": "acme", "X-Request-ID": "req-12345678"})
    assert r.headers["X-Request-ID"] == "req-12345678"
    generated = client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"}).headers["X-Request-ID"]
    assert len(generated) == 32
    assert client.get("/readyz").json() == {"status": "ready"}
    client.get("/v1/datasets/ds_" + "0" * 32, headers={"X-Tenant-ID": "acme"})
    metrics = client.get("/metrics").text
    assert 'ap_http_requests_total{method="GET",route="/v1/datasets",status="200"}' in metrics
    assert 'route="/v1/datasets/{dataset_id}",status="404"' in metrics  # route templates, not raw ids
    assert "ap_http_request_duration_seconds_bucket" in metrics


def test_json_formatter_redacts_pii():
    record = logging.LogRecord("app", logging.INFO, __file__, 1, "user ada@example.com called 415-555-0100", None, None)
    record.tenant_id = "acme"
    line = json.loads(JsonFormatter().format(record))
    assert "ada@example.com" not in line["msg"] and "[EMAIL]" in line["msg"] and line["tenant_id"] == "acme"
