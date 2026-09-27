"""Async job system (MT-003, MT-004, SOC-PI-004).

* A job is a row in the ``jobs`` table (the source of truth for status and progress).
* Its ID travels through the configured cloud queue (in-process, Pub/Sub or SQS).
* Workers run registered handlers with retries. After ``max_attempts`` a job is
  marked failed; the queue's own dead-letter policy catches crashed workers.
* Handlers report progress and check for cancellation cooperatively.
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy import select

from ..db.models import Job, Notification

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.jobs")


class JobCancelled(Exception):
    pass


class PermanentJobError(Exception):
    """Raise from a handler for failures that retrying can't fix (bad input)."""


@dataclass
class JobContext:
    state: AppState
    job_id: str
    tenant_id: str
    actor: str
    params: dict[str, Any]

    def progress(self, fraction: float, message: str | None = None) -> None:
        with self.state.db.session(self.tenant_id) as s:
            job = s.get(Job, self.job_id)
            job.progress = max(0.0, min(1.0, fraction))
            job.heartbeat_at = datetime.now(UTC)
            if message is not None:
                job.message = message[:2000]
            cancelled = job.cancel_requested
        if cancelled:
            raise JobCancelled()

    def check_cancelled(self) -> None:
        with self.state.db.session(self.tenant_id) as s:
            if s.get(Job, self.job_id).cancel_requested:
                raise JobCancelled()


Handler = Callable[[JobContext], dict[str, Any]]
HANDLERS: dict[str, Handler] = {}


def job_handler(job_type: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        HANDLERS[job_type] = fn
        return fn

    return register


class JobOut(BaseModel):
    id: str
    type: str
    status: str
    progress: float
    message: str | None
    params: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None
    attempts: int
    created_by: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def of(cls, job: Job) -> JobOut:
        return cls.model_validate(job, from_attributes=True)


class JobService:
    def __init__(self, state: AppState):
        self.state = state

    def submit(self, tenant_id: str, job_type: str, params: dict[str, Any], actor: str, *, max_attempts: int = 3) -> JobOut:
        if job_type not in HANDLERS:
            raise ValueError(f"unknown job type {job_type!r}")
        with self.state.db.session(tenant_id) as s:
            job = Job(tenant_id=tenant_id, type=job_type, params=params, created_by=actor, max_attempts=max_attempts)
            s.add(job)
            s.flush()
            out = JobOut.of(job)
        self.state.cloud.queue.publish({"job_id": out.id, "tenant_id": tenant_id})
        self.state.audit.record(tenant_id, actor, "job.submit", job_id=out.id, type=job_type)
        return out

    def get(self, tenant_id: str, job_id: str) -> JobOut:
        with self.state.db.session(tenant_id) as s:
            job = s.get(Job, job_id)
            if job is None or job.tenant_id != tenant_id:
                raise LookupError(job_id)
            return JobOut.of(job)

    def list(self, tenant_id: str, status: str | None = None, limit: int = 100) -> list[JobOut]:
        with self.state.db.session(tenant_id) as s:
            q = select(Job).where(Job.tenant_id == tenant_id).order_by(Job.created_at.desc()).limit(limit)
            if status:
                q = q.where(Job.status == status)
            return [JobOut.of(j) for j in s.execute(q).scalars()]

    def cancel(self, tenant_id: str, job_id: str, actor: str) -> JobOut:
        with self.state.db.session(tenant_id) as s:
            job = s.get(Job, job_id)
            if job is None or job.tenant_id != tenant_id:
                raise LookupError(job_id)
            if job.status == "queued":
                job.status, job.finished_at = "cancelled", datetime.now(UTC)
            elif job.status == "running":
                job.cancel_requested = True
            out = JobOut.of(job)
        self.state.audit.record(tenant_id, actor, "job.cancel", job_id=job_id)
        return out


def notify(state: AppState, tenant_id: str, user_id: str | None, kind: str, title: str, body: dict[str, Any] | None = None) -> None:
    """NTF-001: in-app notification, plus webhook fan-out (NTF-004)."""
    with state.db.session(tenant_id) as s:
        s.add(Notification(tenant_id=tenant_id, user_id=user_id, kind=kind, title=title, body=body or {}))
    dispatcher = state.extras.get("webhooks")
    if dispatcher is not None:
        dispatcher.emit(tenant_id, kind, {"title": title, **(body or {})})


class Worker:
    """Pulls job messages from the cloud queue and runs them."""

    def __init__(self, state: AppState, *, wait_seconds: float = 5.0):
        self.state = state
        self.wait_seconds = wait_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self, wait_seconds: float | None = None) -> int:
        messages = self.state.cloud.queue.receive(max_messages=1, wait_seconds=self.wait_seconds if wait_seconds is None else wait_seconds)
        for message in messages:
            retry = self._process(message.body.get("tenant_id"), message.body.get("job_id"))
            if retry:
                self.state.cloud.queue.nack(message)
            else:
                self.state.cloud.queue.ack(message)
        return len(messages)

    def drain(self, max_jobs: int = 100) -> int:
        """Run until the queue is empty (tests and CLI)."""
        done = 0
        while done < max_jobs and self.run_once(wait_seconds=0):
            done += 1
        return done

    def _process(self, tenant_id: str | None, job_id: str | None) -> bool:
        """Run one job. Returns True if the message should be redelivered."""
        if not tenant_id or not job_id:
            return False
        with self.state.db.session(tenant_id) as s:
            job = s.get(Job, job_id)
            if job is None or job.status in ("succeeded", "failed", "cancelled"):
                return False
            if job.cancel_requested:
                job.status, job.finished_at = "cancelled", datetime.now(UTC)
                return False
            job.status, job.attempts = "running", job.attempts + 1
            job.started_at = job.started_at or datetime.now(UTC)
            job.heartbeat_at = datetime.now(UTC)
            ctx = JobContext(self.state, job.id, job.tenant_id, job.created_by, dict(job.params))
            job_type, attempts, max_attempts = job.type, job.attempts, job.max_attempts
        handler = HANDLERS.get(job_type)
        started = time.perf_counter()
        status, result, error, retry = "succeeded", None, None, False
        try:
            if handler is None:
                raise PermanentJobError(f"no handler for job type {job_type!r}")
            result = handler(ctx)
        except JobCancelled:
            status = "cancelled"
        except PermanentJobError as exc:
            status, error = "failed", str(exc)
        except Exception as exc:  # noqa: BLE001 - job boundary
            log.exception("job %s failed (attempt %s/%s)", job_id, attempts, max_attempts)
            error = f"{type(exc).__name__}: {exc}"
            if attempts < max_attempts:
                status, retry = "queued", True
            else:
                status = "failed"
                error += "\n" + traceback.format_exc(limit=5)
        elapsed = time.perf_counter() - started
        with self.state.db.session(tenant_id) as s:
            job = s.get(Job, job_id)
            job.status, job.error = status, error
            if status == "succeeded":
                job.result, job.progress = result or {}, 1.0
            if status != "queued":
                job.finished_at = datetime.now(UTC)
        self.state.metering.add(tenant_id, "compute.seconds", job_type, elapsed)
        if status in ("succeeded", "failed"):
            self.state.audit.record(tenant_id, "system", f"job.{status}", job_id=job_id, type=job_type, seconds=round(elapsed, 3))
            notify(
                self.state,
                tenant_id,
                ctx.actor,
                f"job.{status}",
                f"{job_type} {'finished' if status == 'succeeded' else 'failed'}",
                {"job_id": job_id, "type": job_type, **({"error": error.splitlines()[0]} if error else {})},
            )
        return retry

    # -- background thread (local mode) ------------------------------------------
    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="job-worker", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once(wait_seconds=1.0)
            except Exception:  # noqa: BLE001 - keep the worker alive
                log.exception("worker loop error")
                time.sleep(1)
