"""PII detection and masking (SEC-004, INF-009, CLN-010, LLM-NFR-004)."""

from __future__ import annotations

import hashlib
import re
from enum import Enum

from .schema.model import Semantic

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
PHONE_RE = re.compile(r"(?<![\w-])(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\w-])")
IPV4_RE = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")


def luhn_ok(digits: str) -> bool:
    nums = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(nums) <= 19:
        return False
    total = 0
    for i, n in enumerate(reversed(nums)):
        if i % 2 == 1:
            n = n * 2 - 9 if n * 2 > 9 else n * 2
        total += n
    return total % 10 == 0


# Detectors applied to column *values*. Order matters: SSNs look like phone fragments.
VALUE_DETECTORS: list[tuple[Semantic, re.Pattern[str]]] = [
    (Semantic.EMAIL, re.compile(rf"^{EMAIL_RE.pattern}$")),
    (Semantic.SSN, re.compile(rf"^{SSN_RE.pattern}$")),
    (Semantic.CREDIT_CARD, re.compile(r"^(?:\d[ -]?){13,19}$")),
    (Semantic.IP_ADDRESS, re.compile(rf"^{IPV4_RE.pattern}$")),
    (Semantic.PHONE, re.compile(r"^\+?[\d\s().-]{7,20}$")),
]


def detect_value_semantic(values: list[str], threshold: float = 0.8) -> Semantic | None:
    """Return a semantic if at least ``threshold`` of the non-empty sample values match it."""
    sample = [v.strip() for v in values if isinstance(v, str) and v.strip()]
    if not sample:
        return None
    for semantic, pattern in VALUE_DETECTORS:
        hits = sum(1 for v in sample if pattern.match(v))
        if semantic == Semantic.CREDIT_CARD:
            hits = sum(1 for v in sample if pattern.match(v) and luhn_ok(v))
        if semantic == Semantic.PHONE:
            # Bare digit runs (IDs, amounts) are not phone numbers; require separators or a leading +.
            hits = sum(1 for v in sample if pattern.match(v) and re.search(r"[\s().+-]", v) and sum(c.isdigit() for c in v) >= 7)
        if hits / len(sample) >= threshold:
            return semantic
    return None


def redact_text(text: str) -> str:
    """Replace PII-looking substrings in free text (logs, LLM audit bodies)."""
    text = EMAIL_RE.sub("[EMAIL]", text)
    text = SSN_RE.sub("[SSN]", text)
    text = CARD_RE.sub(lambda m: "[CARD]" if luhn_ok(m.group()) else m.group(), text)
    text = IPV4_RE.sub("[IP]", text)
    text = PHONE_RE.sub("[PHONE]", text)
    return text


class MaskStrategy(str, Enum):
    PARTIAL = "partial"  # keep a hint of the shape: j***@example.com, ***-**-1234
    HASH = "hash"  # stable pseudonym, joinable within a tenant
    REDACT = "redact"  # fixed placeholder


def mask_value(value: object, semantic: Semantic | None = None, strategy: MaskStrategy = MaskStrategy.PARTIAL, salt: str = "") -> object:
    if value is None:
        return None
    text = str(value)
    if strategy == MaskStrategy.REDACT:
        return "[REDACTED]"
    if strategy == MaskStrategy.HASH:
        return hashlib.sha256(f"{salt}:{text}".encode()).hexdigest()[:16]
    if semantic == Semantic.EMAIL and "@" in text:
        local, domain = text.split("@", 1)
        return f"{local[:1]}***@{domain}"
    if semantic in (Semantic.SSN, Semantic.CREDIT_CARD, Semantic.PHONE):
        digits = [c for c in text if c.isdigit()]
        return "***" + "".join(digits[-4:])
    if len(text) <= 2:
        return "*" * len(text)
    return text[0] + "*" * (len(text) - 1)
