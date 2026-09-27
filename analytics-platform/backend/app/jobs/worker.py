"""Standalone worker process: ``python -m app.jobs.worker``.

Deployed as its own Kubernetes Deployment (see deploy/helm), scaled on queue depth.
"""

from __future__ import annotations

import logging
import signal

from ..api.deps import build_state
from . import handlers  # noqa: F401 - registers job handlers
from .core import Worker


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
    state = build_state()
    scheduler = None
    if state.settings.scheduler_tick_seconds > 0:  # ticks are claimed atomically, so every replica may run one
        from .scheduler import Scheduler

        scheduler = Scheduler(state)
    worker = Worker(state, wait_seconds=10, scheduler=scheduler, scheduler_interval=state.settings.scheduler_tick_seconds)
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.getLogger("app.jobs").info("worker started (cloud=%s)", state.cloud.provider)
    while running:
        worker.run_once()


if __name__ == "__main__":
    main()
