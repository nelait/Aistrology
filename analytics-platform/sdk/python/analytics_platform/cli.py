"""``ap``: command-line access to the Analytics Platform (SDK-006).

Credentials come from ``--api-key`` / ``AP_API_KEY``, or from ``ap login``, which
stores rotating user tokens in ``~/.config/analytics-platform/credentials.json``
(mode 0600). Output is JSON, so it composes with ``jq``.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any

from .client import Client
from .errors import AnalyticsPlatformError

CRED_PATH = Path(os.environ.get("AP_CREDENTIALS", Path.home() / ".config" / "analytics-platform" / "credentials.json"))


def _load_creds() -> dict[str, Any]:
    try:
        return json.loads(CRED_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def _save_creds(data: dict[str, Any]) -> None:
    CRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CRED_PATH.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    tmp.replace(CRED_PATH)


def make_client(args: argparse.Namespace) -> Client:
    creds = _load_creds()
    url = args.url or os.environ.get("AP_URL") or creds.get("url") or "http://localhost:8000"
    api_key = args.api_key or os.environ.get("AP_API_KEY")
    if api_key:
        return Client(url, api_key=api_key)

    def persist(tokens: dict[str, Any]) -> None:
        _save_creds({"url": url, "access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]})

    return Client(url, api_key="", access_token=creds.get("access_token"), refresh_token=creds.get("refresh_token"), on_tokens=persist)


def _json_arg(value: str) -> Any:
    """Inline JSON, @file.json, or - for stdin."""
    if value == "-":
        return json.load(sys.stdin)
    if value.startswith("@"):
        return json.loads(Path(value[1:]).read_text())
    return json.loads(value)


def _print(obj: Any) -> None:
    if isinstance(obj, bytes):
        sys.stdout.buffer.write(obj)
    else:
        print(json.dumps(obj, indent=2, default=str))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ap", description="Analytics Platform CLI")
    p.add_argument("--url", help="API base URL (or AP_URL)")
    p.add_argument("--api-key", help="API key (or AP_API_KEY)")
    sub = p.add_subparsers(dest="cmd", required=True)

    login = sub.add_parser("login", help="log in with email and password; stores rotating tokens")
    login.add_argument("email")
    login.add_argument("--totp")
    sub.add_parser("logout")
    sub.add_parser("whoami")

    ds = sub.add_parser("datasets").add_subparsers(dest="action", required=True)
    ds.add_parser("list")
    up = ds.add_parser("upload")
    up.add_argument("path")
    get = ds.add_parser("get")
    get.add_argument("dataset_id")
    prof = ds.add_parser("profile")
    prof.add_argument("dataset_id")
    q = ds.add_parser("query")
    q.add_argument("dataset_id")
    q.add_argument("sql")
    q.add_argument("--limit", type=int, default=1000)

    jobs = sub.add_parser("jobs").add_subparsers(dest="action", required=True)
    jobs.add_parser("list")
    w = jobs.add_parser("wait")
    w.add_argument("job_id")
    w.add_argument("--timeout", type=float, default=3600)
    c = jobs.add_parser("cancel")
    c.add_argument("job_id")

    ex = sub.add_parser("experiments").add_subparsers(dest="action", required=True)
    ex.add_parser("list")
    create = ex.add_parser("create", help="config JSON: inline, @file.json or - (stdin)")
    create.add_argument("name")
    create.add_argument("dataset_id")
    create.add_argument("target")
    create.add_argument("--config", type=_json_arg, default={})
    create.add_argument("--wait", action="store_true")
    eg = ex.add_parser("get")
    eg.add_argument("experiment_id")

    models = sub.add_parser("models").add_subparsers(dest="action", required=True)
    models.add_parser("list")
    reg = models.add_parser("register")
    reg.add_argument("name")
    reg.add_argument("run_id")
    stage = models.add_parser("stage")
    stage.add_argument("model_id")
    stage.add_argument("version", type=int)
    stage.add_argument("stage", choices=["none", "staging", "production", "archived"])

    ep = sub.add_parser("endpoints").add_subparsers(dest="action", required=True)
    ep.add_parser("list")
    dep = ep.add_parser("deploy")
    dep.add_argument("name")
    dep.add_argument("model_id")
    dep.add_argument("--version", type=int)
    pred = ep.add_parser("predict", help="instances JSON: inline, @file.json or - (stdin)")
    pred.add_argument("name")
    pred.add_argument("instances", type=_json_arg)
    pred.add_argument("--explain", action="store_true")
    batch = ep.add_parser("batch")
    batch.add_argument("name")
    batch.add_argument("csv")
    batch.add_argument("--out", help="write predictions CSV here (default stdout)")
    met = ep.add_parser("metrics")
    met.add_argument("name")
    return p


def run(argv: list[str] | None = None, client: Client | None = None) -> int:
    args = build_parser().parse_args(argv)
    ap = client or make_client(args)
    try:
        cmd, action = args.cmd, getattr(args, "action", None)
        if cmd == "login":
            password = os.environ.get("AP_PASSWORD") or getpass.getpass("Password: ")
            tokens = ap.auth.login(args.email, password, args.totp)
            _save_creds({"url": ap.base_url, "access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"]})
            _print({"logged_in": True, "url": ap.base_url})
        elif cmd == "logout":
            ap.auth.logout()
            CRED_PATH.unlink(missing_ok=True)
            _print({"logged_out": True})
        elif cmd == "whoami":
            _print(ap.auth.me())
        elif cmd == "datasets":
            _print(
                {
                    "list": lambda: ap.datasets.list(),
                    "upload": lambda: ap.datasets.upload(args.path),
                    "get": lambda: ap.datasets.get(args.dataset_id),
                    "profile": lambda: ap.datasets.profile(args.dataset_id),
                    "query": lambda: ap.datasets.query(args.dataset_id, args.sql, args.limit),
                }[action]()
            )
        elif cmd == "jobs":
            _print(
                {
                    "list": lambda: ap.jobs.list(),
                    "wait": lambda: ap.jobs.wait(
                        args.job_id,
                        timeout=args.timeout,
                        on_progress=lambda j: print(f"{j['status']} {j['progress']:.0%} {j.get('message') or ''}", file=sys.stderr),
                    ),
                    "cancel": lambda: ap.jobs.cancel(args.job_id),
                }[action]()
            )
        elif cmd == "experiments":
            _print(
                {
                    "list": lambda: ap.experiments.list(),
                    "create": lambda: ap.experiments.create(args.name, args.dataset_id, args.target, wait=args.wait, **args.config),
                    "get": lambda: ap.experiments.get(args.experiment_id),
                }[action]()
            )
        elif cmd == "models":
            _print(
                {
                    "list": lambda: ap.models.list(),
                    "register": lambda: ap.models.register(args.name, args.run_id),
                    "stage": lambda: ap.models.set_stage(args.model_id, args.version, args.stage),
                }[action]()
            )
        elif cmd == "endpoints":
            if action == "batch":
                data = ap.endpoints.batch(args.name, file=args.csv, wait=True)
                if args.out:
                    Path(args.out).write_bytes(data)
                    _print({"written": args.out})
                else:
                    _print(data)
            else:
                _print(
                    {
                        "list": lambda: ap.endpoints.list(),
                        "deploy": lambda: ap.endpoints.deploy(args.name, args.model_id, args.version),
                        "predict": lambda: ap.endpoints.predict(args.name, args.instances, explain=args.explain),
                        "metrics": lambda: ap.endpoints.metrics(args.name),
                    }[action]()
                )
        return 0
    except AnalyticsPlatformError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
