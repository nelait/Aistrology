"""Near-duplicate (fuzzy) row matching (ANA-005a, CLN-003a).

Each row's key columns are normalized (case, accents, punctuation, whitespace)
and joined into one string. Candidate pairs come from a *sorted neighbourhood*
blocking scheme — rows are sorted by the key, and by the reversed key, and each
row is only compared with the next ``window`` rows in each order — so the cost
is O(n · window) instead of O(n²). Pairs whose normalized similarity is at
least ``threshold`` are merged into clusters with union-find.

Similarity is ``rapidfuzz.fuzz.ratio`` (normalized Indel similarity) when
rapidfuzz is installed, otherwise ``difflib.SequenceMatcher.ratio`` (the same
2·M/T definition, slower).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

import numpy as np
import pandas as pd

try:  # pragma: no cover - exercised implicitly
    from rapidfuzz.fuzz import ratio as _rf_ratio

    METHOD = "rapidfuzz"

    def similarity(a: str, b: str) -> float:
        return _rf_ratio(a, b) / 100.0

except ImportError:  # pragma: no cover - rapidfuzz is a dependency
    METHOD = "difflib"

    def similarity(a: str, b: str) -> float:
        return SequenceMatcher(None, a, b, autojunk=False).ratio()


_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")
_ID_RE = re.compile(r"(^|_)(id|uuid|guid|key|pk)$")


def normalize_text(value: Any) -> str:
    if value is None or (isinstance(value, float) and value != value):
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = _PUNCT_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()


def default_key_columns(df: pd.DataFrame) -> list[str]:
    """All columns except surrogate keys: unique per row and integer-typed or id-named (they'd make every row differ)."""
    n = len(df)
    cols = []
    for c in df.columns:
        try:
            unique = df[c].nunique(dropna=True) == n and n > 1
        except TypeError:
            unique = False
        id_like = pd.api.types.is_integer_dtype(df[c]) or bool(_ID_RE.search(str(c).lower()))
        if not (unique and id_like):
            cols.append(c)
    return cols or list(df.columns)


def row_keys(df: pd.DataFrame, columns: list[str]) -> list[str]:
    normalized = [df[c].map(normalize_text).tolist() for c in columns]
    return [" | ".join(parts) for parts in zip(*normalized)] if normalized else [""] * len(df)


@dataclass
class FuzzyMatches:
    columns: list[str]
    threshold: float
    rows: int
    pairs: list[tuple[int, int, float]] = field(default_factory=list)  # positional row indices, similarity
    cluster_of: np.ndarray | None = None  # positional index → cluster root

    @property
    def clusters(self) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {}
        if self.cluster_of is None:
            return out
        for i, root in enumerate(self.cluster_of.tolist()):
            out.setdefault(root, []).append(i)
        return {k: v for k, v in out.items() if len(v) > 1}

    @property
    def duplicate_rows(self) -> int:
        """Rows that fuzzy deduplication would remove (all but one per cluster)."""
        return sum(len(v) - 1 for v in self.clusters.values())


def _find(parent: np.ndarray, i: int) -> int:
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def find_near_duplicates(df: pd.DataFrame, columns: list[str] | None = None, *, threshold: float = 0.9, window: int = 10) -> FuzzyMatches:
    """Cluster rows whose normalized key columns are at least ``threshold`` similar."""
    columns = list(columns) if columns else default_key_columns(df)
    n = len(df)
    result = FuzzyMatches(columns=columns, threshold=threshold, rows=n)
    parent = np.arange(n)
    if n < 2:
        result.cluster_of = parent
        return result
    keys = row_keys(df, columns)
    lengths = np.array([len(k) for k in keys])
    seen: set[tuple[int, int]] = set()
    orders = [
        np.argsort(np.array(keys, dtype=object), kind="stable"),
        np.argsort(np.array([k[::-1] for k in keys], dtype=object), kind="stable"),
    ]
    for order in orders:
        order = order.tolist()
        for pos, i in enumerate(order):
            for j in order[pos + 1 : pos + 1 + window]:
                a, b = (i, j) if i < j else (j, i)
                if (a, b) in seen:
                    continue
                seen.add((a, b))
                ka, kb = keys[a], keys[b]
                if not ka and not kb:
                    continue
                la, lb = lengths[a], lengths[b]
                # Upper bound of the Indel ratio: 2·min/(la+lb). Skip pairs that can't reach the threshold.
                if 2 * min(la, lb) / (la + lb) < threshold:
                    continue
                score = 1.0 if ka == kb else similarity(ka, kb)
                if score >= threshold:
                    result.pairs.append((a, b, round(float(score), 4)))
                    ra, rb = _find(parent, a), _find(parent, b)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
    result.cluster_of = np.array([_find(parent, i) for i in range(n)])
    result.pairs.sort()
    return result


def keep_mask(matches: FuzzyMatches, keep: str = "first") -> np.ndarray:
    """Boolean mask (positional) keeping the first (or last) row of every cluster."""
    mask = np.ones(matches.rows, dtype=bool)
    for members in matches.clusters.values():
        survivor = members[0] if keep == "first" else members[-1]
        for m in members:
            if m != survivor:
                mask[m] = False
    return mask
