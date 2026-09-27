"""Anthropic Claude adapter (LPA-002), built on the official ``anthropic`` SDK."""

from __future__ import annotations

import time

import anthropic

from ..base import LLMProvider, LLMRequest, LLMResponse, ProviderError, ProviderRefusal, Usage

DEFAULT_MODEL = "claude-opus-5"


class AnthropicProvider(LLMProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        name: str = "anthropic",
        base_url: str | None = None,
        timeout: float = 120.0,
        client: anthropic.AsyncAnthropic | None = None,
    ):
        self.name = name
        self.model = model
        # The router owns cross-provider fallback, so SDK-level retries stay low.
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=1)

    async def complete(self, request: LLMRequest) -> LLMResponse:
        kwargs: dict = {
            "model": self.model,
            "max_tokens": request.max_tokens,
            "messages": [m.model_dump() for m in request.messages],
        }
        if request.system:
            kwargs["system"] = request.system
        started = time.perf_counter()
        try:
            message = await self._client.messages.create(**kwargs)
        except anthropic.RateLimitError as exc:
            raise ProviderError(self.name, "rate limited", retryable=True, status=429) from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(
                self.name,
                f"HTTP {exc.status_code}: {exc.message}",
                retryable=exc.status_code in (408, 409) or exc.status_code >= 500,
                status=exc.status_code,
            ) from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(self.name, f"connection error: {exc}", retryable=True) from exc
        if message.stop_reason == "refusal":
            raise ProviderRefusal(self.name)
        text = "".join(block.text for block in message.content if block.type == "text")
        return LLMResponse(
            text=text,
            provider=self.name,
            model=message.model,
            usage=Usage(input_tokens=message.usage.input_tokens, output_tokens=message.usage.output_tokens),
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    async def aclose(self) -> None:
        await self._client.close()
