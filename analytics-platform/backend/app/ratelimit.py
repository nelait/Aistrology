"""Token-bucket rate limiting (MGT-002).

In-process by default. With several API replicas, each enforces the limit on
its own share of traffic; a shared (Redis) bucket implements the same
``allow`` interface when exact global limits are needed.
"""

from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, burst_seconds: float = 10.0, max_keys: int = 100_000):
        self.burst_seconds = burst_seconds
        self.max_keys = max_keys
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, per_minute: int, cost: float = 1.0) -> bool:
        rate = per_minute / 60.0
        capacity = max(1.0, rate * self.burst_seconds, cost)
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (capacity, now))
            tokens = min(capacity, tokens + (now - last) * rate)
            allowed = tokens >= cost
            if allowed:
                tokens -= cost
            if len(self._buckets) >= self.max_keys and key not in self._buckets:
                self._buckets.clear()  # crude bound on memory; buckets refill to capacity anyway
            self._buckets[key] = (tokens, now)
            return allowed
