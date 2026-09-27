"""Fairness analysis across protected attributes (XAI-004).

Computed on the held-out test set of a classification run. At training time the run stores its test-set labels,
predictions and candidate protected attributes (``holdout.parquet``; PII-tagged columns only when explicitly chosen).
A protected attribute does not have to be a model feature: any dataset column works. Numeric attributes with many
values are grouped into quartiles.

Per group: size, selection rate (share predicted positive), base rate, TPR, FPR, precision and accuracy.
Across groups: demographic parity difference / ratio, equalized-odds difference (max of the TPR and FPR gaps) and
the *four-fifths rule* (each group's selection rate ≥ 80 % of the highest group's).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

FOUR_FIFTHS = 0.8
MAX_GROUPS = 50
MISSING = "__missing__"


def _r(v: float | None) -> float | None:
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return round(float(v), 6)


def _rate(num: int, den: int) -> float | None:
    return num / den if den else None


def group_values(values: pd.Series) -> tuple[pd.Series, str]:
    """Group labels for an attribute: categories as strings, or quartile bins for numeric attributes with >10 values."""
    if pd.api.types.is_numeric_dtype(values) and not pd.api.types.is_bool_dtype(values) and values.nunique(dropna=True) > 10:
        try:
            binned = pd.qcut(values, q=4, duplicates="drop", precision=3)
            return binned.astype(str).where(values.notna(), MISSING), "quartiles"
        except ValueError:
            pass
    out = values.astype(object).where(values.notna(), MISSING).astype(str)
    return out, "categories"


def fairness_report(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    attributes: pd.DataFrame,
    protected: list[str],
    positive_index: int,
    *,
    min_group_size: int = 10,
) -> list[dict[str, Any]]:
    """One report per protected attribute. ``y_true``/``y_pred`` are class indices; ``positive_index`` is the class
    treated as the favourable / selected outcome."""
    t = np.asarray(y_true) == positive_index
    p = np.asarray(y_pred) == positive_index
    reports = []
    for attr in protected:
        groups, grouping = group_values(attributes[attr].reset_index(drop=True))
        rows = []
        for g in groups.value_counts().index[:MAX_GROUPS]:
            m = (groups == g).to_numpy()
            n = int(m.sum())
            tp = int((t & p & m).sum())
            fp = int((~t & p & m).sum())
            fn = int((t & ~p & m).sum())
            tn = int((~t & ~p & m).sum())
            rows.append(
                {
                    "group": str(g),
                    "n": n,
                    "selection_rate": _r(_rate(tp + fp, n)),
                    "base_rate": _r(_rate(tp + fn, n)),
                    "tpr": _r(_rate(tp, tp + fn)),
                    "fpr": _r(_rate(fp, fp + tn)),
                    "precision": _r(_rate(tp, tp + fp)),
                    "accuracy": _r(_rate(tp + tn, n)),
                    "small_group": n < min_group_size,
                }
            )
        rows.sort(key=lambda r: r["group"])
        eligible = [r for r in rows if not r["small_group"]] or rows
        sel = [r["selection_rate"] for r in eligible if r["selection_rate"] is not None]
        tprs = [r["tpr"] for r in eligible if r["tpr"] is not None]
        fprs = [r["fpr"] for r in eligible if r["fpr"] is not None]
        max_sel = max(sel) if sel else None
        dp_diff = (max(sel) - min(sel)) if sel else None
        dp_ratio = (min(sel) / max_sel) if sel and max_sel else None
        eo_diff = max((max(tprs) - min(tprs)) if tprs else 0.0, (max(fprs) - min(fprs)) if fprs else 0.0) if (tprs or fprs) else None
        flagged = [
            r["group"]
            for r in eligible
            if max_sel and r["selection_rate"] is not None and r["selection_rate"] / max_sel < FOUR_FIFTHS and not r["small_group"]
        ]
        for r in rows:
            r["selection_ratio"] = _r(r["selection_rate"] / max_sel) if max_sel and r["selection_rate"] is not None else None
        reports.append(
            {
                "attribute": attr,
                "grouping": grouping,
                "groups": rows,
                "demographic_parity_difference": _r(dp_diff),
                "demographic_parity_ratio": _r(dp_ratio),
                "equalized_odds_difference": _r(eo_diff),
                "four_fifths_rule": {"threshold": FOUR_FIFTHS, "passed": not flagged, "flagged_groups": flagged},
            }
        )
    return reports
