"""Natural-language description → canonical schema via the LLM layer (SCH-003, NLP-001/002/004/006)."""

from __future__ import annotations

import json

from ..llm.base import LLMRequest, Message
from ..llm.prompts import DEFAULT_PROMPTS
from ..llm.router import LLMRouter
from .model import Issue, Schema, ensure_valid

# LPA-008: the prompt lives in the central registry; tenants may override it.
PROMPT = DEFAULT_PROMPTS["schema.from_text"]
TEMPLATE_ID = PROMPT.ref
SYSTEM_PROMPT = PROMPT.system


def _prompt_schema() -> str:
    return json.dumps(Schema.model_json_schema(), separators=(",", ":"))


async def parse_natural_language(
    description: str,
    router: LLMRouter,
    *,
    current: Schema | None = None,
    actor: str = "system",
) -> tuple[Schema, list[Issue]]:
    """Parse (or refine, when ``current`` is given — NLP-003) a schema from text.

    The result is always a *proposal* for the user to review before anything is
    generated (NLP-002); callers must not auto-confirm it.
    """
    user = f"<description>\n{description.strip()}\n</description>"
    if current is not None:
        user = (
            "Here is the current schema:\n"
            f"{current.model_dump_json(exclude_none=True)}\n\n"
            "Apply the requested change and return the complete updated schema.\n" + user
        )
    variables = {"json_schema": _prompt_schema()}
    request = LLMRequest(
        system=PROMPT.render(variables),
        template_vars=variables,
        messages=[Message(role="user", content=user)],
        task="schema.from_text",
        template=TEMPLATE_ID,
        max_tokens=8000,
    )
    schema = await router.complete_json(request, Schema, actor=actor)
    return schema, ensure_valid(schema)
