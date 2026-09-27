"""Google Gemini adapter (LPA-002), using the Generative Language REST API."""

from __future__ import annotations

import time

import httpx

from ..base import LLMProvider, LLMRequest, LLMResponse, ProviderError, ProviderRefusal, Usage

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-2.5-pro"
_REFUSAL_REASONS = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"}


class GeminiProvider(LLMProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        name: str = "gemini",
        base_url: str = GEMINI_BASE_URL,
        timeout: float = 120.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def complete(self, request: LLMRequest) -> LLMResponse:
        body: dict = {
            "contents": [{"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]} for m in request.messages],
            "generationConfig": {"maxOutputTokens": request.max_tokens},
        }
        if request.system:
            body["systemInstruction"] = {"parts": [{"text": request.system}]}
        if request.json_output:
            body["generationConfig"]["responseMimeType"] = "application/json"
        started = time.perf_counter()
        try:
            resp = await self._client.post(
                f"{self.base_url}/models/{self.model}:generateContent",
                json=body,
                headers={"x-goog-api-key": self._api_key},
            )
        except httpx.TransportError as exc:
            raise ProviderError(self.name, f"connection error: {exc}", retryable=True) from exc
        if resp.status_code >= 400:
            raise ProviderError(
                self.name,
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                retryable=resp.status_code in (408, 429) or resp.status_code >= 500,
                status=resp.status_code,
            )
        data = resp.json()
        if data.get("promptFeedback", {}).get("blockReason"):
            raise ProviderRefusal(self.name)
        candidates = data.get("candidates") or []
        if not candidates:
            raise ProviderError(self.name, "malformed response: no candidates", retryable=True)
        candidate = candidates[0]
        if candidate.get("finishReason") in _REFUSAL_REASONS:
            raise ProviderRefusal(self.name)
        text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", []))
        usage = data.get("usageMetadata") or {}
        return LLMResponse(
            text=text,
            provider=self.name,
            model=data.get("modelVersion", self.model),
            usage=Usage(input_tokens=usage.get("promptTokenCount", 0), output_tokens=usage.get("candidatesTokenCount", 0)),
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
