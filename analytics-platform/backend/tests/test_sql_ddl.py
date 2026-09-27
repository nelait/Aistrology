"""SCH-004: SQL DDL → canonical schema."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.generation.generator import GenerationOptions, generate
from app.main import create_app
from app.schema.model import FieldType, SchemaValidationError, Semantic
from app.schema.sql_ddl import parse_sql_ddl, tokenize

POSTGRES = """
-- A pg_dump-style schema
CREATE TYPE mood AS ENUM ('happy', 'sad');
CREATE TABLE public.customers (
    id bigserial PRIMARY KEY,
    email character varying(255) NOT NULL UNIQUE,
    full_name varchar(100),
    age integer CHECK (age >= 18 AND age < 130),
    tier text DEFAULT 'bronze'::text CHECK (tier IN ('bronze', 'silver', 'gold')),
    status character varying(10),
    feeling public.mood,
    tags text[],
    balance numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT status_chk CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))
);
CREATE TABLE orders (
    order_id uuid PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    qty int NOT NULL CHECK (qty BETWEEN 1 AND 100),
    total decimal(10, 2) CHECK (total > 0),
    code char(3),
    CHECK (length(code) = 3)
);
CREATE INDEX orders_customer ON orders (customer_id);
"""


def fields(schema, entity):
    return {f.name: f for f in schema.entity(entity).fields}


def test_postgres_constraints_types_and_fks():
    schema, warnings = parse_sql_ddl(POSTGRES)
    assert [e.name for e in schema.entities] == ["customers", "orders"]
    c = fields(schema, "customers")
    assert c["id"].primary_key and c["id"].type == FieldType.INTEGER
    assert c["email"].unique and not c["email"].nullable and c["email"].max_length == 255 and c["email"].semantic == Semantic.EMAIL
    assert (c["age"].minimum, c["age"].maximum) == (18, 129)  # integer: < 130 → max 129
    assert c["tier"].enum == ["bronze", "silver", "gold"]
    assert c["status"].enum == ["a", "b"]  # pg_dump's = ANY (ARRAY[...]) form
    assert c["feeling"].enum == ["happy", "sad"]  # CREATE TYPE … AS ENUM
    assert c["tags"].type == FieldType.ARRAY and c["tags"].items_type == FieldType.STRING
    assert c["balance"].type == FieldType.NUMBER and not c["balance"].nullable
    assert c["created_at"].type == FieldType.DATETIME and c["created_at"].nullable
    o = fields(schema, "orders")
    assert o["order_id"].semantic == Semantic.UUID
    assert o["customer_id"].references.entity == "customers" and o["customer_id"].references.field == "id"
    assert (o["qty"].minimum, o["qty"].maximum) == (1, 100)
    assert o["total"].minimum == 0  # number: > 0 approximated as >= 0
    assert (o["code"].min_length, o["code"].max_length) == (3, 3)
    assert not [w for w in warnings if w.severity == "error"]
    # The parsed schema is directly usable for generation.
    frames = generate(schema, GenerationOptions(count=30, seed=3))
    assert set(frames["orders"]["customer_id"]) <= set(frames["customers"]["id"])


def test_mysql_sqlserver_sqlite_bigquery_snowflake():
    ddl = """
    CREATE TABLE `shop`.`users` (
      `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      `active` TINYINT(1) NOT NULL DEFAULT 1,
      `role` ENUM('admin','user') DEFAULT 'user',
      `bio` TEXT COMMENT 'free text',
      `updated` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      UNIQUE KEY `uq_bio` (`bio`(10)),
      KEY `idx_role` (`role`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    GO
    CREATE TABLE [dbo].[Invoices] (
      [InvoiceId] INT IDENTITY(1,1) NOT NULL,
      [UserId] INT NOT NULL,
      [Amount] MONEY NULL,
      [Guid] UNIQUEIDENTIFIER,
      [Issued] DATETIME2(7),
      CONSTRAINT [PK_Invoices] PRIMARY KEY CLUSTERED ([InvoiceId] ASC),
      CONSTRAINT [FK_User] FOREIGN KEY ([UserId]) REFERENCES [users] ([id])
    ) ON [PRIMARY];
    CREATE TABLE IF NOT EXISTS notes (note_id INTEGER PRIMARY KEY AUTOINCREMENT, body, rating REAL);
    CREATE TABLE `proj.ds.events` (event_id STRING NOT NULL, n INT64, payload JSON, tags ARRAY<STRING>, at TIMESTAMP,
      score FLOAT64 OPTIONS(description="model score"));
    CREATE OR REPLACE TRANSIENT TABLE metrics (id NUMBER(38,0) NOT NULL AUTOINCREMENT START 1 INCREMENT 1, v NUMBER(10,2),
      ts TIMESTAMP_NTZ, flag BOOLEAN, PRIMARY KEY (id));
    """
    schema, warnings = parse_sql_ddl(ddl)
    u = fields(schema, "users")
    assert u["id"].primary_key and u["id"].minimum == 0
    assert u["active"].type == FieldType.BOOLEAN
    assert u["role"].enum == ["admin", "user"]
    assert u["bio"].description == "free text" and u["bio"].unique
    assert u["updated"].type == FieldType.DATETIME
    inv = fields(schema, "Invoices")
    assert inv["InvoiceId"].primary_key and inv["Amount"].type == FieldType.NUMBER and inv["Guid"].semantic == Semantic.UUID
    assert inv["UserId"].references.entity == "users"
    n = fields(schema, "notes")
    assert n["note_id"].primary_key and n["body"].type == FieldType.STRING and n["rating"].type == FieldType.NUMBER
    ev = fields(schema, "events")
    assert ev["n"].type == FieldType.INTEGER and ev["tags"].type == FieldType.ARRAY and ev["tags"].items_type == FieldType.STRING
    assert ev["score"].description == "model score" and ev["at"].type == FieldType.DATETIME
    m = fields(schema, "metrics")
    assert (
        m["id"].type == FieldType.INTEGER
        and m["id"].primary_key
        and m["v"].type == FieldType.NUMBER
        and m["flag"].type == FieldType.BOOLEAN
    )
    assert any("untyped" in w.message or "no type" in w.message for w in warnings)  # SQLite's untyped `body`


def test_alter_table_fk_composite_pk_and_quoted_names():
    ddl = """
    CREATE TABLE "Order Items" ("order id" INT NOT NULL, product_id INT NOT NULL, qty INT, PRIMARY KEY ("order id", product_id));
    CREATE TABLE products (product_id INT PRIMARY KEY, price NUMERIC CHECK (price >= 0 AND price <= 999.5));
    ALTER TABLE ONLY "Order Items" ADD CONSTRAINT fk_p FOREIGN KEY (product_id) REFERENCES products(product_id);
    """
    schema, warnings = parse_sql_ddl(ddl)
    items = schema.entity("Order_Items")
    assert items is not None
    oid = items.field("order_id")
    assert oid.source_name == "order id" and not oid.nullable and not oid.primary_key
    assert items.field("product_id").references.entity == "products"
    assert any("composite primary key" in w.message for w in warnings)
    assert (schema.entity("products").field("price").minimum, schema.entity("products").field("price").maximum) == (0, 999.5)


def test_located_errors():
    with pytest.raises(SchemaValidationError) as exc:
        parse_sql_ddl("CREATE TABLE t (\n  id INT,\n  name VARCHAR(10\n);")
    assert exc.value.issues[0].path.split(":")[0] in ("3", "4")
    with pytest.raises(SchemaValidationError) as exc:
        parse_sql_ddl("CREATE TABLE t (id INT);\n/* never closed")
    assert exc.value.issues[0].path == "2:1"
    with pytest.raises(SchemaValidationError) as exc:
        parse_sql_ddl("CREATE TABLE t (a INT, a TEXT)")
    assert "duplicate column" in exc.value.issues[0].message and exc.value.issues[0].path == "1:24"
    with pytest.raises(SchemaValidationError, match="no CREATE TABLE"):
        parse_sql_ddl("SELECT 1;")
    with pytest.raises(SchemaValidationError, match="unknown column"):
        parse_sql_ddl("CREATE TABLE t (a INT, PRIMARY KEY (b))")
    with pytest.raises(SchemaValidationError, match="unterminated string"):
        parse_sql_ddl("CREATE TABLE t (a TEXT DEFAULT 'oops)")


def test_unmapped_constructs_are_warnings():
    schema, warnings = parse_sql_ddl(
        "CREATE TABLE a (id INT PRIMARY KEY, x INT CHECK (x % 2 = 0), y TEXT CHECK (y LIKE 'A%'), ref INT REFERENCES missing(id));"
        "CREATE VIEW v AS SELECT 1;"
    )
    messages = " | ".join(w.message for w in warnings)
    assert "CHECK" in messages and "unknown table 'missing'" in messages and "statement starting with 'CREATE'" in messages
    assert schema.entity("a").field("ref").references is None
    assert all(w.path.count(":") == 1 for w in warnings)  # line:col


def test_tokenizer_brackets():
    kinds = [(t.kind, t.value) for t in tokenize("[dbo].[T] INT[] ARRAY[1,2]")][:-1]
    assert kinds[0] == ("qword", "dbo") and kinds[2] == ("qword", "T")
    assert ("op", "[") in kinds and ("number", "1") in kinds


def test_parse_endpoint(tmp_path):
    client = TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None)))
    r = client.post("/v1/schemas/parse", json={"format": "sql_ddl", "content": POSTGRES}, headers={"X-Tenant-ID": "acme"})
    assert r.status_code == 200, r.text
    assert [e["name"] for e in r.json()["schema"]["entities"]] == ["customers", "orders"]
    assert r.json()["json_schema"]["$defs"]["orders"]["properties"]["customer_id"]["x-foreign-key"] == "customers.id"
    bad = client.post("/v1/schemas/parse", json={"format": "sql_ddl", "content": "CREATE TABLE t (a INT"}, headers={"X-Tenant-ID": "acme"})
    assert bad.status_code == 422 and ":" in bad.json()["detail"]["issues"][0]["path"]
