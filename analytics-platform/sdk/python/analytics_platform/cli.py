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
    up = ds.add_parser("upload", help="files above 100 MB use resumable uploads automatically")
    up.add_argument("path")
    up.add_argument("--project-id")
    up.add_argument("--resumable", action="store_true", help="force the resumable protocol")
    up.add_argument("--resume", metavar="UPLOAD_ID", help="resume an interrupted resumable upload")
    up.add_argument("--part-size", type=int, help="bytes per part (resumable)")
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
    canary = ep.add_parser("canary", help="canary rollouts: start, status, promote, abort")
    canary.add_argument("name")
    canary.add_argument("op", choices=["start", "status", "promote", "abort"])
    canary.add_argument("--model-version-id", help="candidate model version (start)")
    canary.add_argument("--steps", help="traffic percentages, e.g. 5,25,50,100 (start)")
    canary.add_argument("--step-minutes", type=float)
    canary.add_argument("--max-error-rate", type=float)
    canary.add_argument("--max-p95-ms-increase", type=float)
    canary.add_argument("--min-requests", type=int)
    drift = ep.add_parser("drift", help="drift report (PSI); --check queues an alerting drift check")
    drift.add_argument("name")
    drift.add_argument("--hours", type=int, default=24)
    drift.add_argument("--check", action="store_true")
    drift.add_argument("--wait", action="store_true", help="with --check: wait for the job")

    sch = sub.add_parser("schedules").add_subparsers(dest="action", required=True)
    sl = sch.add_parser("list")
    sl.add_argument("--job-type")
    sch.add_parser("types")
    for action in ("get", "delete", "pause", "resume"):
        sch.add_parser(action).add_argument("schedule_id")
    sc = sch.add_parser("create", help="params JSON: inline, @file.json or - (stdin)")
    sc.add_argument("name")
    sc.add_argument("cron", help='5-field cron expression, e.g. "0 6 * * mon-fri"')
    sc.add_argument("job_type")
    sc.add_argument("--params", type=_json_arg, default={})
    sc.add_argument("--timezone", default="UTC")
    sc.add_argument("--disabled", action="store_true")
    sr = sch.add_parser("run", help="run a schedule once now")
    sr.add_argument("schedule_id")
    sr.add_argument("--wait", action="store_true")

    st = sub.add_parser("streams").add_subparsers(dest="action", required=True)
    stc = st.add_parser("create")
    stc.add_argument("name")
    stc.add_argument("--project-id")
    sts = st.add_parser("send", help="records: JSON array, @file.json, @file.jsonl or - (stdin, JSON or JSON lines)")
    sts.add_argument("dataset_id")
    sts.add_argument("records")
    st.add_parser("status").add_argument("dataset_id")
    stk = st.add_parser("compact")
    stk.add_argument("dataset_id")
    stk.add_argument("--wait", action="store_true")
    return p


def _records_arg(value: str) -> list[dict[str, Any]]:
    """JSON array / ``{"records": [...]}``, or JSON lines, inline, from @file or from stdin (-)."""
    text = sys.stdin.read() if value == "-" else Path(value[1:]).read_text() if value.startswith("@") else value
    try:
        data = json.loads(text)
    except ValueError:
        data = [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(data, dict):
        data = data.get("records", [data])
    return data


def _upload(ap: Client, args: argparse.Namespace) -> Any:
    def progress(sent: int, total: int) -> None:
        print(f"uploaded {sent}/{total} bytes ({sent / total:.0%})", file=sys.stderr)

    if args.resume or args.resumable or args.part_size:
        return ap.datasets.upload_resumable(
            args.path, project_id=args.project_id, upload_id=args.resume, part_size=args.part_size, on_progress=progress
        )
    return ap.datasets.upload(args.path, project_id=args.project_id, on_progress=progress)


def _canary(ap: Client, args: argparse.Namespace) -> Any:
    if args.op == "status":
        return ap.endpoints.canary(args.name)
    if args.op == "promote":
        return ap.endpoints.canary_promote(args.name)
    if args.op == "abort":
        return ap.endpoints.canary_abort(args.name)
    if not args.model_version_id:
        raise SystemExit("error: canary start needs --model-version-id")
    return ap.endpoints.canary_start(
        args.name,
        args.model_version_id,
        steps=[int(s) for s in args.steps.split(",")] if args.steps else None,
        step_minutes=args.step_minutes,
        max_error_rate=args.max_error_rate,
        max_p95_ms_increase=args.max_p95_ms_increase,
        min_requests=args.min_requests,
    )


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
                    "upload": lambda: _upload(ap, args),
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
                        "canary": lambda: _canary(ap, args),
                        "drift": lambda: (
                            ap.endpoints.drift_check(args.name, args.hours, wait=args.wait)
                            if args.check
                            else ap.endpoints.drift(args.name, args.hours)
                        ),
                    }[action]()
                )
        elif cmd == "schedules":
            _print(
                {
                    "list": lambda: ap.schedules.list(args.job_type),
                    "types": lambda: ap.schedules.types(),
                    "get": lambda: ap.schedules.get(args.schedule_id),
                    "create": lambda: ap.schedules.create(
                        args.name, args.cron, args.job_type, args.params, timezone=args.timezone, enabled=not args.disabled
                    ),
                    "run": lambda: ap.schedules.run(args.schedule_id, wait=args.wait),
                    "pause": lambda: ap.schedules.pause(args.schedule_id),
                    "resume": lambda: ap.schedules.resume(args.schedule_id),
                    "delete": lambda: ap.schedules.delete(args.schedule_id) or {"deleted": args.schedule_id},
                }[action]()
            )
        elif cmd == "streams":
            _print(
                {
                    "create": lambda: ap.streams.create(args.name, project_id=args.project_id),
                    "send": lambda: ap.streams.send(args.dataset_id, _records_arg(args.records)),
                    "status": lambda: ap.streams.get(args.dataset_id),
                    "compact": lambda: ap.streams.compact(args.dataset_id, wait=args.wait),
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
