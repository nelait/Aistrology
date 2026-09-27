"""Usage metering (MT-009) persisted in the metadata DB."""

from __future__ import annotations

import threading
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .db.models import UsageCounter
from .db.session import Database
from .llm.base import LLMResponse
from .llm.router import UsageLedger, UsageRecord


class Metering:
    def __init__(self, db: Database):
        self.db = db
        self._lock = threading.Lock()

    def add(self, tenant_id: str, metric: str, key: str, value: float = 1.0, *, day: str | None = None) -> None:
        day = day or datetime.now(UTC).strftime("%Y-%m-%d")
        for _ in range(5):
            with self._lock:
                try:
                    with self.db.session(tenant_id) as s:
                        row = s.get(UsageCounter, (tenant_id, metric, key, day))
                        if row is None:
                            s.add(UsageCounter(tenant_id=tenant_id, metric=metric, key=key, day=day, value=value))
                        else:
                            row.value += value
                    return
                except IntegrityError:
                    continue

    def totals(self, tenant_id: str, *, metric_prefix: str = "", since: str | None = None) -> dict[str, dict[str, float]]:
        """{metric: {key: total}} for the tenant."""
        with self.db.session(tenant_id) as s:
            q = select(UsageCounter).where(UsageCounter.tenant_id == tenant_id, UsageCounter.metric.startswith(metric_prefix))
            if since:
                q = q.where(UsageCounter.day >= since)
            out: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
            for row in s.execute(q).scalars():
                out[row.metric][row.key] += row.value
        return {m: dict(v) for m, v in out.items()}


class DbUsageLedger(UsageLedger):
    """LLM usage ledger (LPA-007) backed by :class:`Metering`."""

    def __init__(self, metering: Metering, pricing=None):
        super().__init__(pricing)
        self.metering = metering

    def record(self, tenant_id: str, response: LLMResponse) -> None:
        key = f"{response.provider}/{response.model}"
        price = self.price(response.model)
        m = self.metering
        m.add(tenant_id, "llm.requests", key)
        m.add(tenant_id, "llm.tokens.input", key, response.usage.input_tokens)
        m.add(tenant_id, "llm.tokens.output", key, response.usage.output_tokens)
        if price is None:
            m.add(tenant_id, "llm.unpriced_requests", key)
        else:
            cost = (response.usage.input_tokens * price[0] + response.usage.output_tokens * price[1]) / 1_000_000
            m.add(tenant_id, "llm.cost_usd", key, cost)

    def for_tenant(self, tenant_id: str) -> dict[str, UsageRecord]:
        totals = self.metering.totals(tenant_id, metric_prefix="llm.")
        keys = set().union(*(v.keys() for v in totals.values())) if totals else set()
        return {
            k: UsageRecord(
                requests=int(totals.get("llm.requests", {}).get(k, 0)),
                input_tokens=int(totals.get("llm.tokens.input", {}).get(k, 0)),
                output_tokens=int(totals.get("llm.tokens.output", {}).get(k, 0)),
                cost_usd=totals.get("llm.cost_usd", {}).get(k, 0.0),
                unpriced_requests=int(totals.get("llm.unpriced_requests", {}).get(k, 0)),
            )
            for k in keys
        }
