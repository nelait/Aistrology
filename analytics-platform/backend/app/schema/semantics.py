"""Guess a field's domain meaning from its name (GEN-003, NLP-005, INF-009)."""

from __future__ import annotations

import re

from .model import FieldType, Semantic

# Order matters: more specific patterns first.
_NAME_RULES: list[tuple[re.Pattern[str], Semantic]] = [
    (re.compile(r"e_?mail"), Semantic.EMAIL),
    (re.compile(r"(phone|mobile|tel(ephone)?|fax)(_?(no|num|number))?$"), Semantic.PHONE),
    (re.compile(r"^(first_?name|given_?name|fname)$"), Semantic.FIRST_NAME),
    (re.compile(r"^(last_?name|surname|family_?name|lname)$"), Semantic.LAST_NAME),
    (re.compile(r"^(full_?name|customer_?name|person_?name|contact_?name|name)$"), Semantic.FULL_NAME),
    (re.compile(r"(^|_)(ssn|social_?security(_?number)?)$"), Semantic.SSN),
    (re.compile(r"(credit_?card|card_?number|cc_?num(ber)?|pan)$"), Semantic.CREDIT_CARD),
    (re.compile(r"(^|_)ip(_?addr(ess)?)?$"), Semantic.IP_ADDRESS),
    (re.compile(r"(street|address(_?line)?(_?\d)?)$"), Semantic.ADDRESS),
    (re.compile(r"(^|_)city$"), Semantic.CITY),
    (re.compile(r"(^|_)country(_?code)?$"), Semantic.COUNTRY),
    (re.compile(r"(zip|postal)_?(code)?$"), Semantic.POSTAL_CODE),
    (re.compile(r"(url|website|homepage|link)$"), Semantic.URL),
    (re.compile(r"(^|_)uuid$|(^|_)guid$"), Semantic.UUID),
    (re.compile(r"(company|employer|organi[sz]ation)(_?name)?$"), Semantic.COMPANY),
    (re.compile(r"^product(_?name)?$"), Semantic.PRODUCT),
    (re.compile(r"^currency(_?code)?$"), Semantic.CURRENCY),
]

_STRING_ONLY = {
    Semantic.EMAIL,
    Semantic.FIRST_NAME,
    Semantic.LAST_NAME,
    Semantic.FULL_NAME,
    Semantic.ADDRESS,
    Semantic.CITY,
    Semantic.COUNTRY,
    Semantic.URL,
    Semantic.COMPANY,
    Semantic.PRODUCT,
    Semantic.CURRENCY,
}


def _snake(name: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def guess_semantic(name: str, ftype: FieldType = FieldType.STRING) -> Semantic | None:
    if ftype in (FieldType.BOOLEAN, FieldType.DATE, FieldType.DATETIME, FieldType.ARRAY):
        return None
    snake = _snake(name)
    for pattern, semantic in _NAME_RULES:
        if pattern.search(snake):
            if semantic in _STRING_ONLY and ftype != FieldType.STRING:
                return None
            return semantic
    return None
