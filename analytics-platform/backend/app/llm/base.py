"""Provider-agnostic LLM contracts (LPA-001).

No module outside ``app.llm`` may import a provider SDK or call a provider API.
Everything goes through :class:`app.llm.router.LLMRouter`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel, Field


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class LLMRequest(BaseModel):
    messages: list[Message]
    system: str | None = None
    max_tokens: int = 16000
    # Ask for a JSON response. Adapters use native JSON modes where they exist;
    # the router always validates the result.
    json_output: bool = False
    # Logical task name, used for per-task model selection (LPA-009) and for metering.
    task: str = "general"
    # Prompt-template id@version, recorded in the audit log (LLM-NFR-003).
    template: str | None = None


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class LLMResponse(BaseModel):
    text: str
    provider: str
    model: str
    usage: Usage = Field(default_factory=Usage)
    latency_ms: float = 0.0
    cached: bool = False


class ProviderError(Exception):
    """A provider call failed. ``retryable`` errors move on to the next provider in the fallback chain."""

    def __init__(self, provider: str, message: str, *, retryable: bool, status: int | None = None):
        self.provider = provider
        self.retryable = retryable
        self.status = status
        super().__init__(f"[{provider}] {message}")


class ProviderRefusal(ProviderError):
    """The model declined the request. Treated as retryable so another provider can try."""

    def __init__(self, provider: str, message: str = "request was refused by the model"):
        super().__init__(provider, message, retryable=True)


class LLMProvider(ABC):
    name: str
    model: str

    @abstractmethod
    async def complete(self, request: LLMRequest) -> LLMResponse:
        """Run one completion. Raise ProviderError (or ProviderRefusal) on failure."""

    async def aclose(self) -> None:  # pragma: no cover - optional hook
        return None
