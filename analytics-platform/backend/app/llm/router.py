"""Tenant-scoped LLM router: fallback chain, caching, metering, audit (LPA-004/005/007/010, LLM-NFR-003/005)."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections import OrderedDict, defaultdict
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from ..audit import AuditLog
from ..privacy import redact_text
from .base import LLMProvider, LLMRequest, LLMResponse, Message, ProviderError

T = TypeVar("T", bound=BaseModel)

# Estimated list prices in USD per 1M tokens (input, output), used for cost estimates
# only (LPA-007). Operators override them per deployment; unknown models are reported as unpriced.
DEFAULT_PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "gpt-4o": (2.50, 10.00),
    "gemini-2.5-pro": (1.25, 10.00),
    "mock-1": (0.0, 0.0),
}


class LLMUnavailableError(RuntimeError):
    def __init__(self, errors: list[ProviderError]):
        self.errors = errors
        super().__init__("all LLM providers failed: " + "; ".join(str(e) for e in errors))


class LLMOutputError(ValueError):
    """The model's output could not be parsed or validated, even after one repair attempt."""


class UsageRecord(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    requests: int = 0
    cost_usd: float = 0.0
    unpriced_requests: int = 0


class UsageLedger:
    """Per-tenant token and cost accounting (LPA-007, MT-009)."""

    def __init__(self, pricing: dict[str, tuple[float, float]] | None = None):
        self.pricing = pricing or DEFAULT_PRICING
        self._usage: dict[str, dict[str, UsageRecord]] = defaultdict(dict)
        self._lock = threading.Lock()

    def price(self, model: str) -> tuple[float, float] | None:
        if model in self.pricing:
            return self.pricing[model]
        # Providers often return a dated or suffixed model id; match on the longest known prefix.
        matches = [k for k in self.pricing if model.startswith(k)]
        return self.pricing[max(matches, key=len)] if matches else None

    def record(self, tenant_id: str, response: LLMResponse) -> None:
        key = f"{response.provider}/{response.model}"
        price = self.price(response.model)
        with self._lock:
            rec = self._usage[tenant_id].setdefault(key, UsageRecord())
            rec.requests += 1
            rec.input_tokens += response.usage.input_tokens
            rec.output_tokens += response.usage.output_tokens
            if price is None:
                rec.unpriced_requests += 1
            else:
                rec.cost_usd += (response.usage.input_tokens * price[0] + response.usage.output_tokens * price[1]) / 1_000_000

    def for_tenant(self, tenant_id: str) -> dict[str, UsageRecord]:
        return {k: v.model_copy() for k, v in self._usage.get(tenant_id, {}).items()}


class ResponseCache:
    """Tenant-scoped LRU cache with TTL (LPA-010). Keys always include the tenant ID, so tenants never share entries."""

    def __init__(self, max_entries: int = 1024, ttl_seconds: float = 3600):
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self._data: OrderedDict[str, tuple[float, LLMResponse]] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def key(tenant_id: str, provider: LLMProvider, request: LLMRequest) -> str:
        payload = json.dumps([tenant_id, provider.name, provider.model, request.model_dump()], sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    def get(self, key: str) -> LLMResponse | None:
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            stored_at, response = hit
            if time.monotonic() - stored_at > self.ttl:
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return response.model_copy(update={"cached": True})

    def put(self, key: str, response: LLMResponse) -> None:
        with self._lock:
            self._data[key] = (time.monotonic(), response)
            self._data.move_to_end(key)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)


_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def extract_json(text: str) -> object:
    """Parse JSON from a model reply, tolerating code fences and surrounding prose."""
    match = _FENCE_RE.match(text)
    if match:
        text = match.group(1)
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        raise LLMOutputError("response contained no JSON")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise LLMOutputError(f"invalid JSON: {exc}") from exc


class LLMRouter:
    """The only entry point modules use to talk to an LLM."""

    def __init__(
        self,
        tenant_id: str,
        providers: list[LLMProvider],
        *,
        ledger: UsageLedger,
        audit: AuditLog,
        cache: ResponseCache | None = None,
    ):
        if not providers:
            raise ValueError("at least one provider is required")
        self.tenant_id = tenant_id
        self.providers = providers
        self.ledger = ledger
        self.audit = audit
        self.cache = cache

    async def complete(self, request: LLMRequest, *, actor: str = "system") -> LLMResponse:
        errors: list[ProviderError] = []
        for provider in self.providers:
            cache_key = ResponseCache.key(self.tenant_id, provider, request) if self.cache else None
            if cache_key and (hit := self.cache.get(cache_key)):  # type: ignore[union-attr]
                self._audit(actor, request, hit, outcome="cache_hit")
                return hit
            try:
                response = await provider.complete(request)
            except ProviderError as exc:
                errors.append(exc)
                self._audit(actor, request, None, outcome="error", provider=provider, error=str(exc))
                if not exc.retryable:
                    break
                continue
            self.ledger.record(self.tenant_id, response)
            self._audit(actor, request, response, outcome="ok")
            if cache_key:
                self.cache.put(cache_key, response)  # type: ignore[union-attr]
            return response
        raise LLMUnavailableError(errors)

    async def complete_json(self, request: LLMRequest, model: type[T], *, actor: str = "system") -> T:
        """Return a validated object. On invalid output, retry once with the errors fed back (NLP-006)."""
        request = request.model_copy(update={"json_output": True})
        response = await self.complete(request, actor=actor)
        try:
            return model.model_validate(extract_json(response.text))
        except (LLMOutputError, ValidationError) as exc:
            first_error = str(exc)[:2000]
        repair = request.model_copy(
            update={
                "messages": [
                    *request.messages,
                    Message(role="assistant", content=response.text),
                    Message(
                        role="user",
                        content="Your previous reply was not valid. Fix these errors and reply with only the corrected JSON:\n"
                        + first_error,
                    ),
                ]
            }
        )
        response = await self.complete(repair, actor=actor)
        try:
            return model.model_validate(extract_json(response.text))
        except (LLMOutputError, ValidationError) as exc:
            raise LLMOutputError(f"model output failed validation after one repair attempt: {exc}") from exc

    def _audit(
        self,
        actor: str,
        request: LLMRequest,
        response: LLMResponse | None,
        *,
        outcome: str,
        provider: LLMProvider | None = None,
        error: str | None = None,
    ) -> None:
        # LLM-NFR-003: metadata always; bodies are redacted and truncated.
        # The retention policy (Appendix B) governs how long bodies are kept.
        prompt = "\n".join(m.content for m in request.messages)
        self.audit.record(
            self.tenant_id,
            actor,
            "llm.call",
            outcome=outcome,
            task=request.task,
            template=request.template,
            provider=response.provider if response else provider.name if provider else None,
            model=response.model if response else provider.model if provider else None,
            input_tokens=response.usage.input_tokens if response else 0,
            output_tokens=response.usage.output_tokens if response else 0,
            latency_ms=round(response.latency_ms, 1) if response else None,
            prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
            prompt_excerpt=redact_text(prompt[:500]),
            error=redact_text(error) if error else None,
        )
