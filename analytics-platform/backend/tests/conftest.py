from __future__ import annotations

import pytest

from app.schema.json_schema import parse_json_schema

CUSTOMER_ORDERS_SCHEMA = {
    "title": "shop",
    "type": "object",
    "properties": {
        "customers": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "email", "name"],
                "properties": {
                    "id": {"type": "integer", "x-primary-key": True},
                    "name": {"type": "string"},
                    "email": {"type": "string", "format": "email", "x-unique": True},
                    "date_of_birth": {"type": "string", "format": "date"},
                    "tier": {"enum": ["bronze", "silver", "gold"]},
                    "address": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}, "postal_code": {"type": "string", "pattern": "^[0-9]{5}$"}},
                    },
                    "orders": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["order_id", "quantity", "total_price"],
                            "properties": {
                                "order_id": {"type": "string", "format": "uuid", "x-primary-key": True},
                                "product_name": {"type": "string"},
                                "quantity": {"type": "integer", "minimum": 1, "maximum": 20},
                                "total_price": {"type": "number", "minimum": 0},
                            },
                        },
                    },
                },
            },
        }
    },
}


@pytest.fixture
def shop_schema():
    schema, _ = parse_json_schema(CUSTOMER_ORDERS_SCHEMA)
    return schema


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch, tmp_path):
    for var in ("AP_CLOUD_PROVIDER", "AP_DATABASE_URL", "AP_DEV_AUTH"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AP_DATA_DIR", str(tmp_path / "default-data"))
    # Tests run jobs deterministically with Worker.drain() instead of a background thread.
    monkeypatch.setenv("AP_INLINE_WORKER", "0")
