"""Vectorized, seeded value generators (GEN-003, GEN-004)."""

from __future__ import annotations

import re
import string
from datetime import UTC, date, datetime, timedelta

import numpy as np

from ..schema.model import Semantic

FIRST_NAMES = np.array(
    "James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara Richard Susan Joseph Jessica "
    "Thomas Sarah Charles Karen Priya Arjun Wei Mei Hiroshi Yuki Carlos Sofia Ahmed Fatima Olga Ivan Kwame Amara Lucas "
    "Emma Noah Olivia Liam Ava Mateo Isabella Aarav Ananya Chen Lin Diego Valentina Omar Layla".split()
)
LAST_NAMES = np.array(
    "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson "
    "Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Patel Sharma "
    "Kim Nguyen Chen Wang Tanaka Sato Muller Schmidt Rossi Silva Okafor Mensah Ivanov Kowalski Novak Haddad Cohen Singh".split()
)
CITIES = np.array(
    "Springfield Riverside Franklin Greenville Bristol Clinton Fairview Salem Madison Georgetown Austin Denver Portland "
    "Seattle Boston Chicago Atlanta Phoenix Toronto London Berlin Paris Madrid Mumbai Bangalore Singapore Sydney Tokyo".split()
)
COUNTRIES = np.array(["US", "CA", "GB", "DE", "FR", "ES", "IN", "SG", "AU", "JP", "BR", "MX", "NL", "SE", "ZA"])
STREETS = np.array("Main Oak Pine Maple Cedar Elm Washington Lake Hill Park View Sunset River Church Mill".split())
STREET_SUFFIX = np.array(["St", "Ave", "Rd", "Blvd", "Ln", "Dr", "Ct", "Way"])
COMPANY_WORDS = np.array("Acme Globex Initech Umbrella Stark Wayne Hooli Vandelay Soylent Cyberdyne Tyrell Wonka".split())
COMPANY_SUFFIX = np.array(["Inc", "LLC", "Ltd", "Group", "Corp", "Co"])
PRODUCT_ADJ = np.array("Ergonomic Rustic Sleek Smart Compact Deluxe Portable Classic Premium Eco".split())
PRODUCT_NOUN = np.array("Chair Lamp Keyboard Backpack Bottle Headphones Desk Mug Watch Speaker Notebook Jacket".split())
CURRENCIES = np.array(["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "SGD"])
EMAIL_DOMAINS = np.array(["example.com", "example.org", "example.net", "mail.example"])
LOREM = np.array(
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna "
    "aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split()
)

DEFAULT_DATE_MIN = date(1970, 1, 1)
DEFAULT_DATE_MAX = date(2025, 12, 31)


def _choice(rng: np.random.Generator, pool: np.ndarray, n: int) -> np.ndarray:
    return pool[rng.integers(0, len(pool), n)]


def _join(*parts: np.ndarray, sep: str = " ") -> list[str]:
    return [sep.join(map(str, row)) for row in zip(*parts)]


def semantic_values(semantic: Semantic, rng: np.random.Generator, n: int) -> list[str]:
    """Values for a semantic type.

    Every independent part (first name, last name, number, ...) draws from its own
    spawned child generator. That makes the output prefix-stable: the first k values
    for n rows equal the values for k rows, so previews match full runs (GEN-010).
    """
    a, b, c, d = rng.spawn(4)
    if semantic == Semantic.FIRST_NAME:
        return _choice(a, FIRST_NAMES, n).tolist()
    if semantic == Semantic.LAST_NAME:
        return _choice(a, LAST_NAMES, n).tolist()
    if semantic == Semantic.FULL_NAME:
        return _join(_choice(a, FIRST_NAMES, n), _choice(b, LAST_NAMES, n))
    if semantic == Semantic.EMAIL:
        first = np.char.lower(_choice(a, FIRST_NAMES, n).astype(str))
        last = np.char.lower(_choice(b, LAST_NAMES, n).astype(str))
        num = c.integers(1, 999, n)
        dom = _choice(d, EMAIL_DOMAINS, n)
        return [f"{fn}.{ln}{x}@{m}" for fn, ln, x, m in zip(first, last, num, dom)]
    if semantic == Semantic.PHONE:
        x, y, z = a.integers(200, 999, n), b.integers(200, 999, n), c.integers(0, 9999, n)
        return [f"+1-{p}-{q}-{r:04d}" for p, q, r in zip(x, y, z)]
    if semantic == Semantic.ADDRESS:
        return _join(a.integers(1, 9999, n), _choice(b, STREETS, n), _choice(c, STREET_SUFFIX, n))
    if semantic == Semantic.CITY:
        return _choice(a, CITIES, n).tolist()
    if semantic == Semantic.COUNTRY:
        return _choice(a, COUNTRIES, n).tolist()
    if semantic == Semantic.POSTAL_CODE:
        return [f"{v:05d}" for v in a.integers(1000, 99999, n)]
    if semantic == Semantic.URL:
        words = np.char.lower(_choice(a, COMPANY_WORDS, n).astype(str))
        return [f"https://www.{w}{i}.example" for w, i in zip(words, b.integers(1, 999, n))]
    if semantic == Semantic.UUID:
        raw = a.integers(0, 256, (n, 16), dtype=np.uint8)
        raw[:, 6] = (raw[:, 6] & 0x0F) | 0x40  # version 4
        raw[:, 8] = (raw[:, 8] & 0x3F) | 0x80  # RFC 4122 variant
        out = []
        for row in raw:
            h = row.tobytes().hex()
            out.append(f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}")
        return out
    if semantic == Semantic.SSN:
        # 9xx area numbers are never issued, so synthetic SSNs can't collide with real ones.
        x, y, z = a.integers(900, 999, n), b.integers(1, 99, n), c.integers(1, 9999, n)
        return [f"{p}-{q:02d}-{r:04d}" for p, q, r in zip(x, y, z)]
    if semantic == Semantic.CREDIT_CARD:
        digits = a.integers(0, 10, (n, 14))
        return [_luhn_complete("4" + "".join(map(str, row))) for row in digits]
    if semantic == Semantic.IP_ADDRESS:
        # TEST-NET ranges (RFC 5737) only.
        nets = np.array(["192.0.2", "198.51.100", "203.0.113"])
        return [f"{p}.{h}" for p, h in zip(_choice(a, nets, n), b.integers(1, 255, n))]
    if semantic == Semantic.COMPANY:
        return _join(_choice(a, COMPANY_WORDS, n), _choice(b, COMPANY_SUFFIX, n))
    if semantic == Semantic.PRODUCT:
        return _join(_choice(a, PRODUCT_ADJ, n), _choice(b, PRODUCT_NOUN, n))
    if semantic == Semantic.CURRENCY:
        return _choice(a, CURRENCIES, n).tolist()
    raise ValueError(f"no generator for semantic {semantic}")


def _luhn_complete(partial: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(partial)):
        d = int(ch)
        if i % 2 == 0:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return partial + str((10 - total % 10) % 10)


def text_values(rng: np.random.Generator, n: int, min_len: int | None, max_len: int | None) -> list[str]:
    lo = max(1, min_len or 1)
    hi = max(lo, min(max_len or 40, 200))
    word_rng, length_rng = rng.spawn(2)
    words = _choice(word_rng, LOREM, n * 8).reshape(n, 8)
    out = []
    for row, target in zip(words, length_rng.integers(lo, hi + 1, n)):
        s = " ".join(row)
        while len(s) < target:
            s = s + " " + s
        out.append(s[:target].rstrip() or s[:target])
    if min_len:
        out = [s.ljust(min_len, "x") for s in out]
    return out


def date_values(rng: np.random.Generator, n: int, lo: date | None, hi: date | None) -> list[date]:
    lo = lo or DEFAULT_DATE_MIN
    hi = hi or DEFAULT_DATE_MAX
    span = max(0, (hi - lo).days)
    return [lo + timedelta(days=int(d)) for d in rng.integers(0, span + 1, n)]


def datetime_values(rng: np.random.Generator, n: int, lo: date | None, hi: date | None) -> list[datetime]:
    start = datetime.combine(lo or DEFAULT_DATE_MIN, datetime.min.time(), tzinfo=UTC)
    end = datetime.combine(hi or DEFAULT_DATE_MAX, datetime.max.time(), tzinfo=UTC)
    span = int((end - start).total_seconds())
    return [start + timedelta(seconds=int(s)) for s in rng.integers(0, span + 1, n)]


# ---------------------------------------------------------------------------
# Regex-driven strings (GEN-004 "regex patterns", common subset)
# ---------------------------------------------------------------------------

_CLASS_SHORTHAND = {
    "d": string.digits,
    "w": string.ascii_letters + string.digits + "_",
    "s": " ",
}


class UnsupportedPattern(ValueError):
    pass


def _parse_class(pattern: str, i: int) -> tuple[str, int]:
    """Parse ``[...]`` starting at pattern[i] == '['. Returns (alphabet, next index)."""
    i += 1
    negate = i < len(pattern) and pattern[i] == "^"
    if negate:
        raise UnsupportedPattern("negated character classes are not supported")
    chars: list[str] = []
    while i < len(pattern) and pattern[i] != "]":
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            nxt = pattern[i + 1]
            chars.extend(_CLASS_SHORTHAND.get(nxt, nxt))
            i += 2
            continue
        if i + 2 < len(pattern) and pattern[i + 1] == "-" and pattern[i + 2] != "]":
            chars.extend(chr(x) for x in range(ord(c), ord(pattern[i + 2]) + 1))
            i += 3
            continue
        chars.append(c)
        i += 1
    if i >= len(pattern):
        raise UnsupportedPattern("unterminated character class")
    return "".join(dict.fromkeys(chars)), i + 1


def _parse_quantifier(pattern: str, i: int) -> tuple[int, int, int]:
    if i >= len(pattern):
        return 1, 1, i
    c = pattern[i]
    if c == "?":
        return 0, 1, i + 1
    if c == "*":
        return 0, 5, i + 1
    if c == "+":
        return 1, 5, i + 1
    if c == "{":
        m = re.match(r"\{(\d+)(,(\d*))?\}", pattern[i:])
        if not m:
            raise UnsupportedPattern("malformed {m,n} quantifier")
        lo = int(m.group(1))
        hi = lo if m.group(2) is None else int(m.group(3)) if m.group(3) else lo + 5
        return lo, hi, i + m.end()
    return 1, 1, i


def compile_pattern(pattern: str) -> list[tuple[str, int, int]]:
    """Compile a regex subset into [(alphabet, min_repeat, max_repeat)].

    Supported: literals, escapes, ``.``, ``[...]`` classes with ranges, ``\\d \\w \\s``,
    quantifiers ``? * + {n} {n,} {n,m}``, and ``^``/``$`` anchors (ignored).
    Groups and alternation raise :class:`UnsupportedPattern`.
    """
    tokens: list[tuple[str, int, int]] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c in "^$":
            i += 1
            continue
        if c in "(|)":
            raise UnsupportedPattern("groups and alternation are not supported")
        if c == "[":
            alphabet, i = _parse_class(pattern, i)
        elif c == "\\" and i + 1 < len(pattern):
            nxt = pattern[i + 1]
            alphabet = _CLASS_SHORTHAND.get(nxt, nxt)
            i += 2
        elif c == ".":
            alphabet = string.ascii_letters + string.digits
            i += 1
        else:
            alphabet = c
            i += 1
        lo, hi, i = _parse_quantifier(pattern, i)
        tokens.append((alphabet, lo, hi))
    return tokens


def pattern_values(pattern: str, rng: np.random.Generator, n: int) -> list[str]:
    tokens = compile_pattern(pattern)
    out = []
    for _ in range(n):
        parts = []
        for alphabet, lo, hi in tokens:
            count = int(rng.integers(lo, hi + 1))
            parts.extend(alphabet[j] for j in rng.integers(0, len(alphabet), count))
        out.append("".join(parts))
    return out
