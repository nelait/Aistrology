"""OpenAI and OpenAI-compatible endpoints (LPA-002, LPA-003).

The ``/chat/completions`` contract is also served by vLLM, Ollama, Together,
Mistral's API, Azure OpenAI and most Llama hosts, which is how Llama/Mistral are
reachable at MVP before their native adapters (LPA-002a).
"""

from __future__ import annotations

import time

import httpx

from ..base import LLMProvider, LLMRequest, LLMResponse, ProviderError, ProviderRefusal, Usage

OPENAI_BASE_URL = "https://api.openai.com/v1"


class OpenAICompatibleProvider(LLMProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = OPENAI_BASE_URL,
        name: str = "openai",
        supports_json_mode: bool = True,
        timeout: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.supports_json_mode = supports_json_mode
        self._api_key = api_key
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def complete(self, request: LLMRequest) -> LLMResponse:
        messages = [{"role": "system", "content": request.system}] if request.system else []
        messages += [m.model_dump() for m in request.messages]
        body: dict = {"model": self.model, "messages": messages, "max_tokens": request.max_tokens}
        if request.json_output and self.supports_json_mode:
            body["response_format"] = {"type": "json_object"}
        started = time.perf_counter()
        try:
            resp = await self._client.post(
                f"{self.base_url}/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        except httpx.TransportError as exc:
            raise ProviderError(self.name, f"connection error: {exc}", retryable=True) from exc
        if resp.status_code >= 400:
            raise ProviderError(
                self.name,
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                retryable=resp.status_code in (408, 409, 429) or resp.status_code >= 500,
                status=resp.status_code,
            )
        data = resp.json()
        try:
            choice = data["choices"][0]
        except (KeyError, IndexError) as exc:
            raise ProviderError(self.name, "malformed response: no choices", retryable=True) from exc
        if choice.get("finish_reason") == "content_filter" or choice.get("message", {}).get("refusal"):
            raise ProviderRefusal(self.name)
        usage = data.get("usage") or {}
        return LLMResponse(
            text=choice.get("message", {}).get("content") or "",
            provider=self.name,
            model=data.get("model", self.model),
            usage=Usage(input_tokens=usage.get("prompt_tokens", 0), output_tokens=usage.get("completion_tokens", 0)),
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
