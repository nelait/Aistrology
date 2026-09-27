"""Deterministic provider for tests, local development and offline demos."""

from __future__ import annotations

from collections.abc import Callable

from ..base import LLMProvider, LLMRequest, LLMResponse, ProviderError, Usage

Responder = Callable[[LLMRequest], str]


class MockProvider(LLMProvider):
    def __init__(
        self,
        responder: Responder | str | list[str] | None = None,
        *,
        name: str = "mock",
        model: str = "mock-1",
        fail_with: ProviderError | None = None,
    ):
        self.name = name
        self.model = model
        self.fail_with = fail_with
        self.calls: list[LLMRequest] = []
        self._responses = list(responder) if isinstance(responder, list) else None
        self._responder = responder if callable(responder) else None
        self._constant = responder if isinstance(responder, str) else None
        if responder is None:
            # Default: task-aware offline demo output (see demo.py).
            from .demo import demo_response

            self._responder = demo_response

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        if self.fail_with is not None:
            raise self.fail_with
        if self._responder is not None:
            text = self._responder(request)
        elif self._responses is not None:
            text = self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]
        else:
            text = self._constant or ""
        prompt_chars = sum(len(m.content) for m in request.messages) + len(request.system or "")
        return LLMResponse(
            text=text,
            provider=self.name,
            model=self.model,
            usage=Usage(input_tokens=max(1, prompt_chars // 4), output_tokens=max(1, len(text) // 4)),
        )
