"""Feature preprocessing (FE-001 date parts, FE-002 encoding, FE-003 scaling, FE-004 selection) and resampling (CFG-006).

Everything that affects inference lives inside one scikit-learn Pipeline, so a
served model applies exactly the transformations it was trained with.
"""

from __future__ import annotations

import re
import warnings
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import (
    FunctionTransformer,
    MinMaxScaler,
    OneHotEncoder,
    OrdinalEncoder,
    RobustScaler,
    StandardScaler,
    TargetEncoder,
)

from ..schema.model import ColumnRole, FieldType
from ..schema.model import Field as SchemaField


class FeatureSelection(BaseModel):
    method: Literal["mutual_info", "correlation", "rfe", "l1"] = "mutual_info"
    k: int = Field(default=20, ge=1, le=10_000)


class PreprocessingConfig(BaseModel):
    encoding: Literal["onehot", "ordinal", "target"] = "onehot"
    scaling: Literal["standard", "minmax", "robust", "log", "none"] = "standard"
    impute: Literal["median", "mean", "most_frequent"] = "median"
    feature_selection: FeatureSelection | None = None
    max_categories: int = Field(default=50, ge=2, le=1000)


class DatePartsExtractor(BaseEstimator, TransformerMixin):
    """Datetime columns → year, month, day, day of week, day of year (FE-001)."""

    PARTS = ("year", "month", "day", "dayofweek", "dayofyear")

    def fit(self, X, y=None):
        self.columns_ = list(X.columns) if hasattr(X, "columns") else [f"d{i}" for i in range(X.shape[1])]
        return self

    def transform(self, X):
        frame = pd.DataFrame(X, columns=self.columns_) if not hasattr(X, "columns") else X
        out = {}
        for col in self.columns_:
            s = pd.to_datetime(frame[col], errors="coerce", format="mixed")
            for part in self.PARTS:
                out[f"{col}_{part}"] = getattr(s.dt, part).astype("float64")
        return pd.DataFrame(out, index=frame.index).to_numpy()

    def get_feature_names_out(self, input_features=None):
        return np.array([f"{c}_{p}" for c in self.columns_ for p in self.PARTS], dtype=object)


def _log1p_signed(x):
    return np.sign(x) * np.log1p(np.abs(x))


def split_features(frame: pd.DataFrame, features: list[str], schema_fields: dict[str, SchemaField]) -> dict[str, list[str]]:
    """Group features into numeric / categorical / datetime; identifiers and free text are dropped."""
    groups: dict[str, list[str]] = {"numeric": [], "categorical": [], "datetime": [], "dropped": []}
    for col in features:
        field = schema_fields.get(col)
        s = frame[col]
        role = field.role if field else None
        if role in (ColumnRole.IDENTIFIER, ColumnRole.TEXT) or (field and field.primary_key):
            groups["dropped"].append(col)
        elif (field and field.type in (FieldType.DATE, FieldType.DATETIME)) or pd.api.types.is_datetime64_any_dtype(s):
            groups["datetime"].append(col)
        elif _ID_NAME_RE.search(col) and s.nunique() > 0.9 * max(1, len(s)):
            groups["dropped"].append(col)  # identifier-like name with (almost) unique values
        elif pd.api.types.is_bool_dtype(s):
            groups["categorical"].append(col)
        elif pd.api.types.is_numeric_dtype(s) and role != ColumnRole.CATEGORICAL:
            groups["numeric"].append(col)
        elif _looks_like_dates(s):
            groups["datetime"].append(col)
        else:
            nunique = s.astype(str).nunique()
            if nunique > 0.9 * max(1, len(s)) and nunique > 50:
                groups["dropped"].append(col)  # looks like an identifier or free text
            else:
                groups["categorical"].append(col)
    return groups


_ID_NAME_RE = re.compile(r"(^id$|_id$|^id_|uuid|guid|_key$)", re.IGNORECASE)


def _looks_like_dates(s: pd.Series) -> bool:
    sample = s.dropna().astype(str).head(500)
    if sample.empty or not sample.str.match(r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}").mean() >= 0.95:
        return False
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return pd.to_datetime(sample, errors="coerce", format="mixed").notna().mean() >= 0.95


def build_preprocessor(groups: dict[str, list[str]], config: PreprocessingConfig, problem_type: str) -> ColumnTransformer:
    scalers: dict[str, Any] = {
        "standard": StandardScaler(),
        "minmax": MinMaxScaler(),
        "robust": RobustScaler(),
        "log": FunctionTransformer(_log1p_signed, feature_names_out="one-to-one"),
        "none": "passthrough",
    }
    transformers = []
    if groups["numeric"]:
        transformers.append(
            ("num", Pipeline([("impute", SimpleImputer(strategy=config.impute)), ("scale", scalers[config.scaling])]), groups["numeric"])
        )
    if groups["categorical"]:
        if config.encoding == "onehot":
            encoder: Any = OneHotEncoder(handle_unknown="infrequent_if_exist", max_categories=config.max_categories, sparse_output=False)
        elif config.encoding == "ordinal":
            encoder = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, encoded_missing_value=-1)
        else:
            encoder = TargetEncoder(target_type="continuous" if problem_type == "regression" else "auto", random_state=0)
        transformers.append(
            (
                "cat",
                Pipeline(
                    [
                        ("to_str", FunctionTransformer(_as_str, feature_names_out="one-to-one")),
                        ("impute", SimpleImputer(strategy="constant", fill_value="__missing__")),
                        ("encode", encoder),
                    ]
                ),
                groups["categorical"],
            )
        )
    if groups["datetime"]:
        transformers.append(
            (
                "date",
                Pipeline(
                    [("parts", DatePartsExtractor()), ("impute", SimpleImputer(strategy="median")), ("scale", scalers[config.scaling])]
                ),
                groups["datetime"],
            )
        )
    if not transformers:
        raise ValueError("no usable features: every selected column is an identifier or free text")
    return ColumnTransformer(transformers, remainder="drop", verbose_feature_names_out=True)


def _as_str(x):
    """Categories as strings (so mixed int/str columns encode consistently); missing stays NaN for the imputer."""
    frame = pd.DataFrame(x).astype(object)
    missing = frame.isna()
    frame = frame.astype(str).mask(missing, np.nan)
    return frame.to_numpy(dtype=object)


def feature_selector(config: FeatureSelection, problem_type: str, seed: int):
    from sklearn.feature_selection import (
        RFE,
        SelectFromModel,
        SelectKBest,
        f_classif,
        f_regression,
        mutual_info_classif,
        mutual_info_regression,
    )
    from sklearn.linear_model import Lasso, LogisticRegression

    classification = problem_type != "regression"
    if config.method == "mutual_info":
        return SelectKBest(mutual_info_classif if classification else mutual_info_regression, k="all" if config.k <= 0 else config.k)
    if config.method == "correlation":
        return SelectKBest(f_classif if classification else f_regression, k=config.k)
    if config.method == "rfe":
        base = LogisticRegression(max_iter=500) if classification else Lasso(alpha=0.01)
        return RFE(base, n_features_to_select=config.k)
    base = LogisticRegression(l1_ratio=1.0, solver="saga", C=0.5, max_iter=2000, random_state=seed) if classification else Lasso(alpha=0.01)
    return SelectFromModel(base, max_features=config.k)


class SafeSelectKBest(BaseEstimator, TransformerMixin):
    """Wraps a selector so ``k`` never exceeds the number of available features."""

    def __init__(self, selector):
        self.selector = selector

    def fit(self, X, y=None):
        n = X.shape[1]
        if hasattr(self.selector, "k") and self.selector.k != "all" and self.selector.k > n:
            self.selector.set_params(k="all")
        if hasattr(self.selector, "n_features_to_select") and (self.selector.n_features_to_select or 0) > n:
            self.selector.set_params(n_features_to_select=n)
        if hasattr(self.selector, "max_features") and isinstance(self.selector.max_features, int) and self.selector.max_features > n:
            self.selector.set_params(max_features=n)
        self.selector.fit(X, y)
        self.n_features_in_ = n  # marks the wrapper as fitted for sklearn's checks
        return self

    def transform(self, X):
        return self.selector.transform(X)

    def get_support(self, indices=False):
        return self.selector.get_support(indices=indices)

    def get_feature_names_out(self, input_features=None):
        return self.selector.get_feature_names_out(input_features)


# -- class imbalance (CFG-006) -------------------------------------------------------------------------------


def resample(X: np.ndarray, y: np.ndarray, method: str, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Random over/undersampling or SMOTE on the (already preprocessed) training matrix only."""
    if method in ("none", "class_weight"):
        return X, y
    rng = np.random.default_rng(seed)
    classes, counts = np.unique(y, return_counts=True)
    if len(classes) < 2:
        return X, y
    if method == "undersample":
        n = counts.min()
        idx = np.concatenate([rng.choice(np.flatnonzero(y == c), n, replace=False) for c in classes])
    elif method == "oversample":
        n = counts.max()
        idx = np.concatenate([rng.choice(np.flatnonzero(y == c), n, replace=True) for c in classes])
    elif method == "smote":
        return _smote(X, y, classes, counts, rng)
    else:
        raise ValueError(f"unknown resampling method {method!r}")
    rng.shuffle(idx)
    return X[idx], y[idx]


def _smote(X, y, classes, counts, rng, k: int = 5):
    """SMOTE: synthesize minority samples by interpolating towards random same-class nearest neighbours."""
    from sklearn.neighbors import NearestNeighbors

    target = counts.max()
    xs, ys = [X], [y]
    for cls, count in zip(classes, counts):
        need = target - count
        if need <= 0:
            continue
        members = X[y == cls]
        if len(members) < 2:
            xs.append(members[rng.integers(0, len(members), need)])
            ys.append(np.full(need, cls))
            continue
        nn = NearestNeighbors(n_neighbors=min(k + 1, len(members))).fit(members)
        _, neighbors = nn.kneighbors(members)
        base = rng.integers(0, len(members), need)
        pick = neighbors[base, rng.integers(1, neighbors.shape[1], need)]
        gap = rng.random((need, 1))
        xs.append(members[base] + gap * (members[pick] - members[base]))
        ys.append(np.full(need, cls))
    return np.vstack(xs), np.concatenate(ys)


def original_feature(transformed_name: str, groups: dict[str, list[str]]) -> str:
    """Map a transformed feature name (``cat__region_east``, ``date__when_month``) back to its source column."""
    prefix, _, rest = transformed_name.partition("__")
    candidates = groups.get({"num": "numeric", "cat": "categorical", "date": "datetime"}.get(prefix, ""), [])
    for col in sorted(candidates, key=len, reverse=True):
        if rest == col or rest.startswith(col + "_"):
            return col
    return rest or transformed_name
