"""LLM provider health monitoring and circuit breaking (LPA-006).

The router reports every provider call here: latency, success, error or refusal. The monitor keeps a
rolling time window per ``(tenant, provider)`` and platform-wide per provider, and a circuit breaker per
``(tenant, provider)``:

* closed: calls flow; ``failure_threshold`` consecutive failures open the breaker.
* open: the router skips the provider for ``open_seconds`` (moving on down the fallback chain).
* half-open: after the cool-down one probe call is let through; success closes, failure re-opens.

The breaker is off unless enabled (``AP_LLM_BREAKER_ENABLED=1`` or the tenant's setting), and the router
never skips *every* provider: if all are open, it tries them anyway, so a breaker can't turn a
recoverable outage into a guaranteed failure. Refusals are recorded but never trip the breaker, because
they are about the request, not provider health.

State is in-process; each API/worker replica keeps its own view, which is what a breaker needs.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

OK, ERROR, REFUSAL = "ok", "error", "refusal"
PLATFORM_SCOPE = "*"


class BreakerConfig(BaseModel):
    """Per-tenant circuit breaker settings (tenant setting ``llm_breaker``)."""

    enabled: bool = False
    failure_threshold: int = Field(default=5, ge=1, le=100)
    open_seconds: float = Field(default=30.0, ge=1, le=3600)


@dataclass
class _Breaker:
    state: str = "closed"  # closed | open | half_open
    consecutive_failures: int = 0
    opened_at: float = 0.0
    probe_in_flight: bool = False


@dataclass
class _Window:
    events: deque = field(default_factory=deque)  # (monotonic ts, outcome, latency_ms)


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return round(ordered[idx], 1)


class ProviderHealthMonitor:
    def __init__(self, window_seconds: float = 900.0, max_events: int = 5000, clock: Callable[[], float] = time.monotonic):
        self.window_seconds = window_seconds
        self.max_events = max_events
        self.clock = clock
        self._windows: dict[tuple[str, str], _Window] = {}
        self._breakers: dict[tuple[str, str], _Breaker] = {}
        self._lock = threading.Lock()

    # -- recording ---------------------------------------------------------------------------------
    def record(self, tenant_id: str, provider: str, outcome: str, latency_ms: float, config: BreakerConfig | None = None) -> None:
        now = self.clock()
        with self._lock:
            for scope in (tenant_id, PLATFORM_SCOPE):
                window = self._windows.setdefault((scope, provider), _Window())
                window.events.append((now, outcome, latency_ms))
                self._trim(window, now)
            breaker = self._breakers.setdefault((tenant_id, provider), _Breaker())
            if outcome == OK:
                breaker.state, breaker.consecutive_failures, breaker.probe_in_flight = "closed", 0, False
            elif outcome == ERROR:
                breaker.consecutive_failures += 1
                threshold = config.failure_threshold if config else 5
                if breaker.state == "half_open" or breaker.consecutive_failures >= threshold:
                    breaker.state, breaker.opened_at = "open", now
                breaker.probe_in_flight = False
            else:  # refusal: the provider answered; it's healthy, but this doesn't reset a failure streak
                breaker.probe_in_flight = False

    def _trim(self, window: _Window, now: float) -> None:
        horizon = now - self.window_seconds
        while window.events and (window.events[0][0] < horizon or len(window.events) > self.max_events):
            window.events.popleft()

    # -- circuit breaker ---------------------------------------------------------------------------
    def allow(self, tenant_id: str, provider: str, config: BreakerConfig) -> bool:
        """May the router call ``provider`` now? Always True when the breaker is disabled."""
        if not config.enabled:
            return True
        now = self.clock()
        with self._lock:
            breaker = self._breakers.get((tenant_id, provider))
            if breaker is None or breaker.state == "closed":
                return True
            if breaker.state == "open":
                if now - breaker.opened_at < config.open_seconds:
                    return False
                breaker.state, breaker.probe_in_flight = "half_open", True
                return True
            # half-open: one probe at a time
            if breaker.probe_in_flight:
                return False
            breaker.probe_in_flight = True
            return True

    def breaker_state(self, tenant_id: str, provider: str) -> str:
        with self._lock:
            breaker = self._breakers.get((tenant_id, provider))
            return breaker.state if breaker else "closed"

    # -- reporting ---------------------------------------------------------------------------------
    def snapshot(self, scope: str) -> list[dict[str, Any]]:
        """Stats per provider for a tenant, or platform-wide with ``scope='*'``."""
        now = self.clock()
        out = []
        with self._lock:
            for (s, provider), window in sorted(self._windows.items()):
                if s != scope:
                    continue
                self._trim(window, now)
                events = list(window.events)
                total = len(events)
                errors = sum(1 for e in events if e[1] == ERROR)
                refusals = sum(1 for e in events if e[1] == REFUSAL)
                latencies = [e[2] for e in events if e[1] == OK]
                item: dict[str, Any] = {
                    "provider": provider,
                    "requests": total,
                    "errors": errors,
                    "refusals": refusals,
                    "error_rate": round(errors / total, 4) if total else 0.0,
                    "refusal_rate": round(refusals / total, 4) if total else 0.0,
                    "latency_ms": {
                        "p50": _percentile(latencies, 0.5),
                        "p95": _percentile(latencies, 0.95),
                        "max": _percentile(latencies, 1),
                    },
                    "last_outcome": events[-1][1] if events else None,
                    "seconds_since_last": round(now - events[-1][0], 1) if events else None,
                }
                if scope != PLATFORM_SCOPE:
                    item["breaker"] = self._breakers.get((scope, provider), _Breaker()).state
                else:
                    item["open_breakers"] = sum(1 for (t, p), b in self._breakers.items() if p == provider and b.state != "closed")
                item["status"] = _status(item)
                out.append(item)
        return out


def _status(item: dict[str, Any]) -> str:
    if item.get("breaker", "closed") != "closed":
        return "unhealthy"
    if item["requests"] >= 5 and item["error_rate"] >= 0.5:
        return "unhealthy"
    if item["requests"] >= 5 and item["error_rate"] >= 0.1:
        return "degraded"
    return "healthy"
