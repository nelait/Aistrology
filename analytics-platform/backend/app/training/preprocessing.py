"""Feature preprocessing (FE-001 date parts + automatic interactions, FE-002 encoding, FE-003 scaling, FE-004 selection,
FE-005 PCA) and resampling (CFG-006).

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


class AutoFeatures(BaseModel):
    """FE-001: pairwise interactions (a×b) and squares (a²) of the ``top_k`` most informative numeric features."""

    interactions: bool = True
    polynomial: bool = True  # degree-2 terms (squares) in addition to interactions
    top_k: int = Field(default=5, ge=2, le=20)


class PCAConfig(BaseModel):
    """FE-005: project the preprocessed features onto principal components.

    ``n_components`` < 1 keeps enough components to explain that share of the variance; ≥ 1 is a component count.
    Explanations are then reported per component (``pca0``, ``pca1``, …).
    """

    n_components: float = Field(default=0.95, gt=0.0, le=1000)


class PreprocessingConfig(BaseModel):
    encoding: Literal["onehot", "ordinal", "target"] = "onehot"
    scaling: Literal["standard", "minmax", "robust", "log", "none"] = "standard"
    impute: Literal["median", "mean", "most_frequent"] = "median"
    feature_selection: FeatureSelection | None = None
    max_categories: int = Field(default=50, ge=2, le=1000)
    auto_features: AutoFeatures | None = None
    pca: PCAConfig | None = None


class PairwiseFeatures(BaseEstimator, TransformerMixin):
    """FE-001: products of every pair of input columns (``a x b``) and, optionally, squares (``a^2``).

    Only the new terms are emitted; the linear terms already come from the numeric branch.
    """

    def __init__(self, interactions: bool = True, squares: bool = True):
        self.interactions = interactions
        self.squares = squares

    def fit(self, X, y=None):
        self.columns_ = list(X.columns) if hasattr(X, "columns") else [f"x{i}" for i in range(np.asarray(X).shape[1])]
        pairs: list[tuple[int, int]] = []
        n = len(self.columns_)
        for i in range(n):
            for j in range(i, n):
                if (i == j and self.squares) or (i != j and self.interactions):
                    pairs.append((i, j))
        self.pairs_ = pairs
        self.n_features_in_ = n
        return self

    def transform(self, X):
        arr = np.asarray(X, dtype=float)
        if not self.pairs_:
            return np.empty((arr.shape[0], 0))
        return np.column_stack([arr[:, i] * arr[:, j] for i, j in self.pairs_])

    def get_feature_names_out(self, input_features=None):
        c = list(input_features) if input_features is not None else self.columns_
        return np.array([f"{c[i]}^2" if i == j else f"{c[i]} x {c[j]}" for i, j in self.pairs_], dtype=object)


class CappedPCA(BaseEstimator, TransformerMixin):
    """FE-005: PCA whose component count never exceeds what the data supports; outputs ``pca0``, ``pca1``, …"""

    def __init__(self, n_components: float = 0.95, random_state: int = 0):
        self.n_components = n_components
        self.random_state = random_state

    def fit(self, X, y=None):
        from sklearn.decomposition import PCA

        arr = np.asarray(X, dtype=float)
        limit = max(1, min(arr.shape))
        n = self.n_components if self.n_components < 1 else min(int(self.n_components), limit)
        self.pca_ = PCA(n_components=n, svd_solver="full", random_state=self.random_state).fit(arr)
        self.n_features_in_ = arr.shape[1]
        return self

    def transform(self, X):
        return self.pca_.transform(np.asarray(X, dtype=float))

    def get_feature_names_out(self, input_features=None):
        return np.array([f"pca{i}" for i in range(self.pca_.n_components_)], dtype=object)


def rank_numeric(frame: pd.DataFrame, numeric: list[str], y: np.ndarray | None, problem_type: str, k: int) -> list[str]:
    """FE-001: pick the ``k`` numeric features most related to the target (|correlation| / mutual information), or with
    the highest standardized spread when there is no target (clustering)."""
    if len(numeric) <= k:
        return list(numeric)
    X = frame[numeric].astype(float)
    X = X.fillna(X.median())
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if y is None:
            scores = (X.std() / (X.abs().mean() + 1e-9)).fillna(0).to_numpy()
        elif problem_type == "regression":
            scores = np.abs([np.nan_to_num(np.corrcoef(X[c], y)[0, 1]) for c in numeric])
        else:
            from sklearn.feature_selection import mutual_info_classif

            scores = mutual_info_classif(X.to_numpy(), y, random_state=0)
    order = np.argsort(-np.asarray(scores), kind="stable")[:k]
    return [numeric[i] for i in sorted(order)]


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
    """One ColumnTransformer for every feature group. ``groups["engineered"]`` (FE-001) lists the numeric columns that
    get pairwise interaction / square terms."""
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
    if groups.get("engineered") and config.auto_features:
        af = config.auto_features
        transformers.append(
            (
                "fe",
                Pipeline(
                    [
                        ("impute", SimpleImputer(strategy=config.impute)),
                        ("scale0", StandardScaler()),
                        ("pairs", PairwiseFeatures(interactions=af.interactions, squares=af.polynomial)),
                        ("scale", clone_scaler(scalers[config.scaling])),
                    ]
                ),
                groups["engineered"],
            )
        )
    if groups["categorical"]:
        if config.encoding == "target" and problem_type == "clustering":
            config = config.model_copy(update={"encoding": "onehot"})  # no target to encode against
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


def clone_scaler(scaler: Any) -> Any:
    from sklearn.base import clone

    return scaler if isinstance(scaler, str) else clone(scaler)


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


def original_features(transformed_name: str, groups: dict[str, list[str]]) -> list[str]:
    """Source columns of a transformed feature; engineered interactions (``fe__a x b``, FE-001) map to both inputs."""
    prefix, _, rest = transformed_name.partition("__")
    if prefix == "fe":
        numeric = sorted(groups.get("numeric", []), key=len, reverse=True)
        if rest.endswith("^2") and rest[:-2] in numeric:
            return [rest[:-2]]
        for a in numeric:
            if rest.startswith(a + " x ") and rest[len(a) + 3 :] in numeric:
                return [a, rest[len(a) + 3 :]]
        return [rest]
    return [original_feature(transformed_name, groups)]


def original_feature(transformed_name: str, groups: dict[str, list[str]]) -> str:
    """Map a transformed feature name (``cat__region_east``, ``date__when_month``) back to its source column."""
    prefix, _, rest = transformed_name.partition("__")
    candidates = groups.get({"num": "numeric", "cat": "categorical", "date": "datetime"}.get(prefix, ""), [])
    for col in sorted(candidates, key=len, reverse=True):
        if rest == col or rest.startswith(col + "_"):
            return col
    return rest or transformed_name
