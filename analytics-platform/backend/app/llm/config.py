"""Per-tenant LLM configuration, BYOK secret handling and provider construction (LPA-003/004/005)."""

from __future__ import annotations

import threading
from enum import Enum

from pydantic import BaseModel, Field, field_validator

from .base import LLMProvider
from .providers.mock import MockProvider


class ProviderKind(str, Enum):
    OPENAI = "openai"
    OPENAI_COMPATIBLE = "openai_compatible"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    MOCK = "mock"


DEFAULT_MODELS = {
    ProviderKind.OPENAI: "gpt-4o",
    ProviderKind.ANTHROPIC: "claude-opus-5",
    ProviderKind.GEMINI: "gemini-2.5-pro",
    ProviderKind.MOCK: "mock-1",
}


class DataMinimization(str, Enum):
    """LLM-NFR-004 levels."""

    L0_SCHEMA = "L0"
    L1_PROFILE = "L1"
    L2_MASKED_SAMPLES = "L2"
    L3_RAW_SAMPLES = "L3"


class ProviderConfig(BaseModel):
    kind: ProviderKind
    model: str | None = None
    base_url: str | None = None
    # Name of the secret that holds the API key. The key itself never enters this model,
    # the database or the logs (LPA-004, SEC-005).
    secret_name: str | None = None

    @field_validator("base_url")
    @classmethod
    def _https_only(cls, v: str | None) -> str | None:
        if v and not v.startswith("https://"):
            raise ValueError("base_url must use https://")
        return v

    def resolved_model(self) -> str:
        if self.model:
            return self.model
        if self.kind == ProviderKind.OPENAI_COMPATIBLE:
            raise ValueError("openai_compatible providers need an explicit model")
        return DEFAULT_MODELS[self.kind]


class TenantLLMConfig(BaseModel):
    # Ordered fallback chain; the first entry is the primary provider.
    chain: list[ProviderConfig] = Field(default_factory=lambda: [ProviderConfig(kind=ProviderKind.MOCK)], min_length=1, max_length=5)
    data_minimization: DataMinimization = DataMinimization.L2_MASKED_SAMPLES
    cache_enabled: bool = True


class SecretStore:
    """Tenant-scoped secret storage. In production this wraps a cloud Secret Manager or Vault (SEC-005)."""

    def __init__(self) -> None:
        self._secrets: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def put(self, tenant_id: str, name: str, value: str) -> None:
        with self._lock:
            self._secrets[(tenant_id, name)] = value

    def get(self, tenant_id: str, name: str) -> str | None:
        return self._secrets.get((tenant_id, name))

    def names(self, tenant_id: str) -> list[str]:
        return sorted(n for t, n in self._secrets if t == tenant_id)


class MissingSecretError(LookupError):
    pass


def build_provider(tenant_id: str, config: ProviderConfig, secrets: SecretStore) -> LLMProvider:
    model = config.resolved_model()
    if config.kind == ProviderKind.MOCK:
        return MockProvider(model=model)
    if not config.secret_name:
        raise MissingSecretError(f"provider {config.kind.value} needs secret_name")
    api_key = secrets.get(tenant_id, config.secret_name)
    if api_key is None:
        raise MissingSecretError(f"secret {config.secret_name!r} is not set for this tenant")
    if config.kind == ProviderKind.ANTHROPIC:
        from .providers.anthropic import AnthropicProvider

        return AnthropicProvider(api_key=api_key, model=model, base_url=config.base_url)
    if config.kind == ProviderKind.GEMINI:
        from .providers.gemini import GEMINI_BASE_URL, GeminiProvider

        return GeminiProvider(api_key=api_key, model=model, base_url=config.base_url or GEMINI_BASE_URL)
    from .providers.openai_compat import OPENAI_BASE_URL, OpenAICompatibleProvider

    if config.kind == ProviderKind.OPENAI_COMPATIBLE and not config.base_url:
        raise ValueError("openai_compatible providers need base_url")
    return OpenAICompatibleProvider(
        api_key=api_key,
        model=model,
        base_url=config.base_url or OPENAI_BASE_URL,
        name=config.kind.value,
        supports_json_mode=config.kind == ProviderKind.OPENAI,
    )
