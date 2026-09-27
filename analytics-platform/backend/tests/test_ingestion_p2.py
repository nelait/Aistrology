"""ING-003a formats, ING-006 archives, CLN-009 transcoding, INF-004/005 multi-table keys, INF-007/008 evolution."""

from __future__ import annotations

import base64
import gzip
import io
import tarfile
import zipfile
import zlib

import pandas as pd
import pyarrow as pa
import pyarrow.orc as orc
import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.ingestion.archive import ArchiveError, ArchiveTooLarge
from app.ingestion.formats import DataFormat, UnsupportedFormatError
from app.ingestion.prepare import prepare_upload
from app.main import create_app

ACME = {"X-Tenant-ID": "acme", "X-User-ID": "ana"}

# A three-row legacy .xls workbook (id, name, score), generated with xlwt.
PEOPLE_XLS = zlib.decompress(
    base64.b64decode(
        "eNrtWE1oE0EU/mY32/zYpklNhVYoJWDVWg/ixUtdW9GeLNVLRQRNmj2Uxk2IXupBqzVHQfCkeCn04qXqxR/0oDcPQqUeBEVI9OhJUPDQZn3zdlbTmkMDWvyZ"
        "L8ybt2/m23mZefN2Z18uJitz97qrWIP9MFHzomipswkq0eAiAWr3PKkGdYSKp/FXIRqhhWyx8LjtRViuoVzvKgzcDT0jCbynchJFjBZcp3cDMcw+ZIT0YZCk"
        "wC2yxNHFXnWwnGC5meUd7vmE5QG2XGU5SH0r4gQW7dH+fSqKjxtpbotD3vcBc96wZQ868VxG8cVrwu9rYag0mcn/mQ09oVbMg9ZtxHGdUiZfQYoWcB5fvF7g"
        "c7BTn/Zq+8baBcj+dbU93MB+3QgBM/BOc4CXKSCXTH8TFp1CMe8sYzdvSFkoPCdz1N3NnHEs4OxEoeRQ5yHXJTlcyFL7wemYzNC8oxOrdnQbR3oryRzaWU9y"
        "vCcoZy/f/rR0JDtmn2LLDGdxP9dvk+7BwyXJIHKcW0IspZ/9zNjF8jLfdSvr3SxTFKVU9411KuXwLPe5wq19NM5exit7e52+g/Tyx6MPe8of7J2kL4xUz6cW"
        "XttzSNOzJ0d8+ZvFgBgQN29IPLKDWqi88I5l1085ImIklO+eeqC1YwUxVpMs/Ss5O+L7laHmSrLFGvYFI8a2JM+y7C+YLWfHb5Pst3GfbTRgG8yOKba/MiHF"
        "Npg9vslnmw3YJrPjim0y21Jsk9lp+Sw3OnBfDkSZ8Qdi0NDQ0NDQ0NDQ+P8g/KMFv0nK905LnRjC6rvOCpWa/kzyz+IYCvQ7RwfTQ3CpLmG6qfjZAksE9xLr"
        "5ATfCyXGafQSppBlP6aajl868Yn6/7NuYuLXbaFmx6814+dvHv8bbgHN8w=="
    )
)

CUSTOMERS = "id,name,city\n" + "\n".join(f"{i},Customer {i},{['Paris', 'Oslo', 'Rome'][i % 3]}" for i in range(1, 41))
ORDERS = "order_id,customer_id,amount\n" + "\n".join(f"{1000 + i},{(i % 40) + 1},{10 + i}.5" for i in range(120))
XML_ORDERS = b"""<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="urn:x">
  <orders>
    <order id="1"><customer>Ann</customer><items><item><sku>A</sku><qty>2</qty></item><item><sku>B</sku><qty>1</qty></item></items></order>
    <order id="2"><customer>Bob</customer><items><item><sku>C</sku><qty>5</qty></item></items></order>
  </orders>
</export>"""


def _zip(members: dict[str, bytes], compression=zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=compression) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _targz(members: dict[str, bytes], symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        if symlink:
            link = tarfile.TarInfo(symlink)
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            tf.addfile(link)
    return buf.getvalue()


def _prepare(tmp_path, name: str, data: bytes, max_bytes: int = 10_000_000):
    tmp_path.mkdir(parents=True, exist_ok=True)
    src = tmp_path / "upload.bin"
    src.write_bytes(data)
    return prepare_upload(src, name, tmp_path / "work", max_bytes=max_bytes)


# -- ING-003a formats ---------------------------------------------------------------------------


def test_xls_avro_orc_are_converted(tmp_path):
    import fastavro

    xls = _prepare(tmp_path, "people.xls", PEOPLE_XLS)
    t = xls.tables[0]
    assert t.source_format == DataFormat.XLS and t.format == DataFormat.PARQUET and t.row_count == 3
    assert pd.read_parquet(t.path)["name"].tolist() == ["Ann", "Bob", "Cy"]

    schema = {
        "type": "record",
        "name": "E",
        "fields": [{"name": "id", "type": "long"}, {"name": "tags", "type": {"type": "array", "items": "string"}}],
    }
    buf = io.BytesIO()
    fastavro.writer(buf, schema, [{"id": i, "tags": ["a", str(i)]} for i in range(5)])
    avro = _prepare(tmp_path / "a", "events.avro", buf.getvalue()).tables[0]
    frame = pd.read_parquet(avro.path)
    assert avro.source_format == DataFormat.AVRO and frame["id"].tolist() == [0, 1, 2, 3, 4] and frame["tags"][1] == '["a", "1"]'

    obuf = io.BytesIO()
    orc.write_table(pa.table({"k": [1, 2, 3], "v": ["x", "y", "z"]}), obuf)
    o = _prepare(tmp_path / "o", "t.orc", obuf.getvalue()).tables[0]
    assert o.source_format == DataFormat.ORC and pd.read_parquet(o.path)["v"].tolist() == ["x", "y", "z"]

    with pytest.raises(UnsupportedFormatError, match="xls"):
        _prepare(tmp_path / "bad", "broken.xls", b"\xd0\xcf\x11\xe0" + b"\x00" * 600)


def test_xml_records_and_repeated_children_become_rows(tmp_path):
    t = _prepare(tmp_path, "orders.xml", XML_ORDERS).tables[0]
    frame = pd.read_parquet(t.path)
    assert t.source_format == DataFormat.XML and len(frame) == 3
    assert frame["id"].tolist() == ["1", "1", "2"] and frame["customer"].tolist() == ["Ann", "Ann", "Bob"]
    assert frame["items_item_sku"].tolist() == ["A", "B", "C"] and frame["items_item_qty"].tolist() == ["2", "1", "5"]
    assert any("<order>" in n for n in t.notes)

    with pytest.raises(UnsupportedFormatError, match="DOCTYPE"):
        _prepare(tmp_path / "x", "evil.xml", b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "boom">]><r><a>&e;</a></r>')
    with pytest.raises(UnsupportedFormatError, match="invalid XML"):
        _prepare(tmp_path / "y", "broken.xml", b"<r><a>1</a><a>2</r>")


# -- ING-006 archives ---------------------------------------------------------------------------


def test_zip_gz_and_targz(tmp_path):
    z = _prepare(
        tmp_path / "z",
        "bundle.zip",
        _zip({"data/customers.csv": CUSTOMERS.encode(), "orders.csv": ORDERS.encode(), "README.md": b"# notes"}),
    )
    assert z.archive == "zip" and [t.name for t in z.tables] == ["customers", "orders"]
    assert any("skipped" in n for n in z.tables[0].notes)  # README.md isn't a data file

    g = _prepare(tmp_path / "g", "sales.csv.gz", gzip.compress(ORDERS.encode()))
    assert g.archive == "gzip" and g.tables[0].name == "sales" and g.tables[0].format == DataFormat.CSV

    tgz = _prepare(tmp_path / "t", "dump.tar.gz", _targz({"a/customers.csv": CUSTOMERS.encode(), "orders.jsonl": b'{"x":1}\n{"x":2}\n'}))
    assert tgz.archive == "tar.gz" and {t.name: t.format for t in tgz.tables} == {"customers": DataFormat.CSV, "orders": DataFormat.JSONL}


def test_archive_attacks_are_rejected(tmp_path):
    bomb = _zip({"zeros.csv": b"a\n" + b"0\n" * 1_500_000})
    with pytest.raises(ArchiveError, match="zip bomb"):
        _prepare(tmp_path / "b", "bomb.zip", bomb)
    with pytest.raises(ArchiveError, match="zip bomb"):
        _prepare(tmp_path / "bg", "bomb.csv.gz", gzip.compress(b"a\n" + b"0\n" * 1_500_000))
    with pytest.raises(ArchiveError, match="traversal"):
        _prepare(tmp_path / "t", "evil.zip", _zip({"../../evil.csv": b"a,b\n1,2\n"}))
    with pytest.raises(ArchiveError, match="absolute"):
        _prepare(tmp_path / "a", "evil.zip", _zip({"/etc/cron.d/x.csv": b"a,b\n1,2\n"}))
    with pytest.raises(ArchiveError, match="link"):
        _prepare(tmp_path / "l", "evil.tar.gz", _targz({"ok.csv": b"a,b\n1,2\n"}, symlink="passwd.csv"))
    with pytest.raises(ArchiveError, match="nested"):
        _prepare(tmp_path / "n", "nested.zip", _zip({"inner.zip": _zip({"a.csv": b"a,b\n1,2\n"})}))
    # The limit applies to the uncompressed size, even when the archive itself is small.
    big = ("x,y\n" + "\n".join(f"{i},{i * 7919 % 10007}" for i in range(40_000))).encode()
    with pytest.raises(ArchiveTooLarge):
        _prepare(tmp_path / "s", "big.csv.gz", gzip.compress(big), max_bytes=200_000)
    with pytest.raises(ArchiveTooLarge):
        _prepare(tmp_path / "s2", "big.zip", _zip({"big.csv": big}), max_bytes=200_000)


# -- CLN-009 encodings ----------------------------------------------------------------------------


def test_non_utf8_text_is_transcoded(tmp_path):
    text = "name,city,price\n" + "\n".join(f"Café {i},Zürich,{i}€" for i in range(50))
    t = _prepare(tmp_path / "w", "prices.csv", text.encode("cp1252")).tables[0]
    assert t.source_encoding in ("cp1252", "windows-1252") and t.encoding == "utf-8"
    assert t.path.read_text(encoding="utf-8") == text

    jp = "名前,都市\n" + "\n".join(f"山田太郎{i},東京都港区" for i in range(40))
    t = _prepare(tmp_path / "j", "jp.csv", jp.encode("shift_jis")).tables[0]
    assert t.source_encoding in ("shift_jis", "cp932") and t.path.read_text(encoding="utf-8") == jp

    t = _prepare(tmp_path / "u16", "u16.csv", "a,b\nü,1\n".encode("utf-16")).tables[0]
    assert t.source_encoding == "utf-16" and t.path.read_text(encoding="utf-8") == "a,b\nü,1\n"

    plain = _prepare(tmp_path / "p", "plain.csv", "a,b\nü,1\n".encode())
    assert plain.passthrough and plain.tables[0].encoding == "utf-8"


# -- API: uploads, multi-table keys, evolution --------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    return TestClient(
        create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, max_dataset_bytes=300_000))
    )


def _upload(client, name: str, data: bytes):
    return client.post("/v1/datasets", files={"file": (name, data)}, headers=ACME)


def _query(client, dataset_id: str, sql: str):
    r = client.post(f"/v1/datasets/{dataset_id}/query", json={"sql": sql}, headers=ACME)
    assert r.status_code == 200, r.text
    return r.json()["rows"]


def test_zip_upload_becomes_multi_table_dataset_with_keys(client):
    r = _upload(client, "shop.zip", _zip({"customers.csv": CUSTOMERS.encode(), "orders.csv": ORDERS.encode()}))
    assert r.status_code == 201, r.text
    ds, inf = r.json()["dataset"], r.json()["inference"]
    assert [t["name"] for t in ds["tables"]] == ["customers", "orders"]
    assert all(t["raw_file"].endswith("/raw/shop.zip") for t in ds["tables"])
    entities = {e["name"]: {f["name"]: f for f in e["fields"]} for e in ds["schema"]["entities"]}
    assert entities["customers"]["id"]["primary_key"] and entities["orders"]["order_id"]["primary_key"]  # INF-004
    assert entities["orders"]["customer_id"]["references"] == {"entity": "customers", "field": "id"}  # INF-005
    rel = inf["relationships"][0]
    assert rel["containment"] == 1.0 and rel["child_field"] == "customer_id"
    assert _query(client, ds["id"], "SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id") == [[120]]


def test_uploads_of_p1_formats_and_encodings(client):
    r = _upload(client, "people.xls", PEOPLE_XLS)
    assert r.status_code == 201, r.text
    table = r.json()["dataset"]["tables"][0]
    assert table["format"] == "parquet" and table["source_format"] == "xls" and table["row_count"] == 3
    assert _query(client, r.json()["dataset"]["id"], "SELECT name FROM data ORDER BY id") == [["Ann"], ["Bob"], ["Cy"]]

    r = _upload(client, "orders.xml", XML_ORDERS)
    assert r.status_code == 201 and len(_query(client, r.json()["dataset"]["id"], "SELECT * FROM data")) == 3

    latin = ("name,city\n" + "\n".join(f"Renée {i},Göteborg" for i in range(30))).encode("latin-1")
    r = _upload(client, "latin.csv", latin)
    assert r.status_code == 201
    table = r.json()["dataset"]["tables"][0]
    assert table["encoding"] == "utf-8" and table["source_encoding"] not in (None, "utf-8")
    assert any("converted from" in w for w in r.json()["inference"]["warnings"])
    assert _query(client, r.json()["dataset"]["id"], "SELECT city FROM data LIMIT 1") == [["Göteborg"]]

    r = _upload(client, "sales.csv.gz", gzip.compress(ORDERS.encode()))
    assert r.status_code == 201 and r.json()["dataset"]["name"] == "sales"
    big = ("x,y\n" + "\n".join(f"{i},{i * 7919 % 10007}" for i in range(40_000))).encode()
    assert _upload(client, "big.csv.gz", gzip.compress(big)).status_code == 413  # uncompressed size counts
    assert _upload(client, "bomb.zip", _zip({"z.csv": b"a\n" + b"0\n" * 1_500_000})).status_code in (413, 422)
    assert _upload(client, "evil.zip", _zip({"../x.csv": b"a\n1\n"})).status_code == 422


def test_new_version_with_schema_evolution(client):
    v1 = "id,name,amount,region\n" + "\n".join(f"{i},n{i},{i * 2},east" for i in range(1, 31))
    ds = _upload(client, "sales_jan.csv", v1.encode()).json()["dataset"]
    # Confirm the schema with an annotation, which must survive into the next version.
    schema = ds["schema"]
    schema["entities"][0]["fields"][1]["annotations"] = ["pii"]
    assert client.put(f"/v1/datasets/{ds['id']}/schema", json=schema, headers=ACME).status_code == 200

    v2 = "id,name,amount,channel\n" + "\n".join(f"{i},n{i},{'n/a' if i % 2 else i * 3},web" for i in range(31, 51))
    r = client.post(f"/v1/datasets/{ds['id']}/versions", files={"file": ("sales_feb.csv", v2.encode())}, headers=ACME)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["dataset"]["version"] == 2 and body["dataset"]["parent_version"] == 1 and body["previous_version"] == 1
    assert body["dataset"]["tables"][0]["name"] == "sales_jan"  # the table keeps its name
    entity = body["diff"]["entities"][0]
    assert [f["name"] for f in entity["added_fields"]] == ["channel"]
    assert [(t["field"], t["from_type"], t["to_type"]) for t in entity["retyped_fields"]] == [("amount", "integer", "string")]
    assert body["diff"]["breaking"] is True
    # Appended: 30 + 20 rows; columns missing from one side are null.
    rows = _query(client, ds["id"], "SELECT count(*), count(region), count(channel) FROM data")
    assert rows == [[50, 30, 20]]
    fields = {f["name"]: f for f in body["dataset"]["schema"]["entities"][0]["fields"]}
    assert fields["name"]["annotations"] == ["pii"]  # confirmed definitions carry over
    # Replace mode: only the new file's rows; the removed column is reported.
    v3 = "id,name\n1,a\n2,b\n"
    r = client.post(f"/v1/datasets/{ds['id']}/versions?mode=replace", files={"file": ("x.csv", v3.encode())}, headers=ACME)
    assert r.status_code == 201
    removed = {f["name"] for f in r.json()["diff"]["entities"][0]["removed_fields"]}
    assert removed == {"amount", "region", "channel"}
    assert _query(client, ds["id"], "SELECT count(*) FROM data") == [[2]]
    versions = client.get(f"/v1/datasets/{ds['id']}/versions", headers=ACME).json()
    assert [v["version"] for v in versions] == [1, 2, 3]
    # Unknown dataset / other tenant.
    other = client.post(f"/v1/datasets/{ds['id']}/versions", files={"file": ("x.csv", b"a\n1\n")}, headers={"X-Tenant-ID": "globex"})
    assert other.status_code == 404
