"""Algorithm catalog (TRN-001 … TRN-007) with documented hyperparameters and search spaces (CFG-001/002/003).

Supervised algorithms live in ``ALGORITHMS``. Ensembles (TRN-005) are built from the best AutoML candidates and
resolved through :func:`get_algorithm`; clustering (TRN-006) and forecasting (TRN-007) have their own catalogs in
``clustering.py`` / ``forecasting.py`` and are listed alongside through :func:`catalog`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

ProblemType = Literal["binary", "multiclass", "regression", "clustering", "forecasting", "anomaly"]
CLASSIFICATION = ("binary", "multiclass")


class HyperParameter(BaseModel):
    name: str
    type: Literal["int", "float", "categorical", "bool"]
    default: Any
    min: float | None = None
    max: float | None = None
    choices: list[Any] | None = None
    log: bool = False
    help: str


class AlgorithmInfo(BaseModel):
    id: str
    name: str
    family: str
    problem_types: list[str]
    supports_class_weight: bool
    hyperparameters: list[HyperParameter]


@dataclass
class Algorithm:
    id: str
    name: str
    family: str
    problem_types: tuple[str, ...]
    build: Callable[[str, dict[str, Any], int], Any]  # (problem_type, params, seed) -> estimator
    hyperparameters: list[HyperParameter] = field(default_factory=list)
    supports_class_weight: bool = False
    tree_based: bool = False
    linear: bool = False

    def info(self) -> AlgorithmInfo:
        return AlgorithmInfo(
            id=self.id,
            name=self.name,
            family=self.family,
            problem_types=list(self.problem_types),
            supports_class_weight=self.supports_class_weight,
            hyperparameters=self.hyperparameters,
        )

    def defaults(self) -> dict[str, Any]:
        return {h.name: h.default for h in self.hyperparameters}


def _hp(name, type_, default, help_, *, min=None, max=None, choices=None, log=False) -> HyperParameter:  # noqa: A002
    return HyperParameter(name=name, type=type_, default=default, help=help_, min=min, max=max, choices=choices, log=log)


# -- builders --------------------------------------------------------------------------------------


def _logistic(problem, p, seed):
    from sklearn.linear_model import LogisticRegression

    penalty = p.get("penalty", "l2")
    return LogisticRegression(
        C=p.get("C", 1.0),
        l1_ratio={"l2": 0.0, "l1": 1.0, "elasticnet": p.get("l1_ratio", 0.5)}[penalty],
        solver="saga" if penalty != "l2" else "lbfgs",
        max_iter=p.get("max_iter", 1000),
        class_weight=p.get("class_weight"),
        random_state=seed,
    )


def _linear(problem, p, seed):
    from sklearn.linear_model import ElasticNet, Lasso, LinearRegression, Ridge

    kind = p.get("regularization", "none")
    alpha = p.get("alpha", 1.0)
    if kind == "ridge":
        return Ridge(alpha=alpha, random_state=seed)
    if kind == "lasso":
        return Lasso(alpha=alpha, random_state=seed, max_iter=5000)
    if kind == "elasticnet":
        return ElasticNet(alpha=alpha, l1_ratio=p.get("l1_ratio", 0.5), random_state=seed, max_iter=5000)
    return LinearRegression()


def _tree(problem, p, seed):
    from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

    common = dict(max_depth=p.get("max_depth"), min_samples_leaf=p.get("min_samples_leaf", 1), random_state=seed)
    if problem in CLASSIFICATION:
        return DecisionTreeClassifier(class_weight=p.get("class_weight"), **common)
    return DecisionTreeRegressor(**common)


def _forest(problem, p, seed):
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

    common = dict(
        n_estimators=p.get("n_estimators", 200),
        max_depth=p.get("max_depth"),
        min_samples_leaf=p.get("min_samples_leaf", 1),
        max_features=p.get("max_features", "sqrt"),
        n_jobs=-1,
        random_state=seed,
    )
    if problem in CLASSIFICATION:
        return RandomForestClassifier(class_weight=p.get("class_weight"), **common)
    return RandomForestRegressor(**{**common, "max_features": p.get("max_features", 1.0)})


def _hist_gb(problem, p, seed):
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

    common = dict(
        learning_rate=p.get("learning_rate", 0.1),
        max_iter=p.get("max_iter", 200),
        max_leaf_nodes=p.get("max_leaf_nodes", 31),
        l2_regularization=p.get("l2_regularization", 0.0),
        early_stopping=True,
        random_state=seed,
    )
    if problem in CLASSIFICATION:
        return HistGradientBoostingClassifier(class_weight=p.get("class_weight"), **common)
    return HistGradientBoostingRegressor(**common)


def _xgb(problem, p, seed):
    import xgboost as xgb

    common = dict(
        n_estimators=p.get("n_estimators", 300),
        learning_rate=p.get("learning_rate", 0.1),
        max_depth=p.get("max_depth", 6),
        subsample=p.get("subsample", 1.0),
        colsample_bytree=p.get("colsample_bytree", 1.0),
        reg_lambda=p.get("reg_lambda", 1.0),
        random_state=seed,
        n_jobs=4,
        tree_method="hist",
        verbosity=0,
    )
    if problem in CLASSIFICATION:
        return xgb.XGBClassifier(**common)
    return xgb.XGBRegressor(**common)


def _lgbm(problem, p, seed):
    import lightgbm as lgb

    common = dict(
        n_estimators=p.get("n_estimators", 300),
        learning_rate=p.get("learning_rate", 0.1),
        num_leaves=p.get("num_leaves", 31),
        min_child_samples=p.get("min_child_samples", 20),
        subsample=p.get("subsample", 1.0),
        subsample_freq=1 if p.get("subsample", 1.0) < 1 else 0,
        colsample_bytree=p.get("colsample_bytree", 1.0),
        reg_lambda=p.get("reg_lambda", 0.0),
        random_state=seed,
        n_jobs=4,
        verbose=-1,
    )
    if problem in CLASSIFICATION:
        return lgb.LGBMClassifier(class_weight=p.get("class_weight"), **common)
    return lgb.LGBMRegressor(**common)


def _catboost(problem, p, seed):
    """TRN-002a: CatBoost (ordered boosting). Categoricals arrive already encoded by the shared preprocessor."""
    from catboost import CatBoostClassifier, CatBoostRegressor

    common = dict(
        iterations=p.get("iterations", 300),
        learning_rate=p.get("learning_rate", 0.1),
        depth=p.get("depth", 6),
        l2_leaf_reg=p.get("l2_leaf_reg", 3.0),
        random_seed=seed,
        thread_count=4,
        verbose=0,
        allow_writing_files=False,
    )
    if problem in CLASSIFICATION:
        return CatBoostClassifier(auto_class_weights="Balanced" if p.get("class_weight") == "balanced" else None, **common)
    return CatBoostRegressor(**common)


def _svm(problem, p, seed):
    from sklearn.svm import SVC, SVR

    common = dict(C=p.get("C", 1.0), kernel=p.get("kernel", "rbf"), degree=p.get("degree", 3), gamma=p.get("gamma", "scale"))
    if problem in CLASSIFICATION:
        return SVC(probability=True, class_weight=p.get("class_weight"), random_state=seed, **common)
    return SVR(**common)


def _mlp(problem, p, seed):
    from sklearn.neural_network import MLPClassifier, MLPRegressor

    width, depth = p.get("hidden_units", 64), p.get("hidden_layers", 2)
    common = dict(
        hidden_layer_sizes=(width,) * depth,
        alpha=p.get("alpha", 1e-4),
        learning_rate_init=p.get("learning_rate_init", 1e-3),
        max_iter=p.get("max_iter", 300),
        early_stopping=True,
        random_state=seed,
    )
    return MLPClassifier(**common) if problem in CLASSIFICATION else MLPRegressor(**common)


# -- catalog ----------------------------------------------------------------------------------------

_CLS = ("binary", "multiclass")
_ALL = ("binary", "multiclass", "regression")

_MAX_DEPTH = _hp(
    "max_depth", "int", None, "Maximum tree depth. Deeper trees fit more detail but overfit more easily. Empty = unlimited.", min=2, max=32
)
_MIN_LEAF = _hp(
    "min_samples_leaf",
    "int",
    1,
    "Minimum samples per leaf. Larger values smooth the model and reduce overfitting.",
    min=1,
    max=100,
    log=True,
)
_N_EST = _hp(
    "n_estimators", "int", 300, "Number of trees. More trees are more accurate up to a point, and slower.", min=50, max=1000, log=True
)
_LR = _hp(
    "learning_rate", "float", 0.1, "Shrinkage per boosting round. Lower is more accurate but needs more trees.", min=0.01, max=0.3, log=True
)
_SUBSAMPLE = _hp(
    "subsample", "float", 1.0, "Fraction of rows sampled per tree. Values below 1 add randomness and reduce overfitting.", min=0.5, max=1.0
)
_COLSAMPLE = _hp("colsample_bytree", "float", 1.0, "Fraction of features sampled per tree.", min=0.5, max=1.0)

ALGORITHMS: dict[str, Algorithm] = {
    a.id: a
    for a in [
        Algorithm(
            "logistic_regression",
            "Logistic Regression",
            "linear",
            _CLS,
            _logistic,
            [
                _hp(
                    "C",
                    "float",
                    1.0,
                    "Inverse regularization strength. Smaller values = stronger regularization (simpler model).",
                    min=1e-3,
                    max=100,
                    log=True,
                ),
                _hp(
                    "penalty",
                    "categorical",
                    "l2",
                    "Regularization type: l2 (ridge), l1 (lasso, sparse) or elasticnet (mix).",
                    choices=["l2", "l1", "elasticnet"],
                ),
                _hp("l1_ratio", "float", 0.5, "Elastic-net mixing: 0 = pure l2, 1 = pure l1.", min=0.0, max=1.0),
            ],
            supports_class_weight=True,
            linear=True,
        ),
        Algorithm(
            "linear_regression",
            "Linear Regression (OLS / Ridge / Lasso / Elastic Net)",
            "linear",
            ("regression",),
            _linear,
            [
                _hp(
                    "regularization",
                    "categorical",
                    "none",
                    "none = ordinary least squares; ridge/lasso/elasticnet add a penalty that shrinks coefficients.",
                    choices=["none", "ridge", "lasso", "elasticnet"],
                ),
                _hp("alpha", "float", 1.0, "Penalty strength for ridge/lasso/elasticnet.", min=1e-4, max=100, log=True),
                _hp("l1_ratio", "float", 0.5, "Elastic-net mixing: 0 = ridge, 1 = lasso.", min=0.0, max=1.0),
            ],
            linear=True,
        ),
        Algorithm(
            "decision_tree", "Decision Tree", "tree", _ALL, _tree, [_MAX_DEPTH, _MIN_LEAF], supports_class_weight=True, tree_based=True
        ),
        Algorithm(
            "random_forest",
            "Random Forest",
            "ensemble",
            _ALL,
            _forest,
            [
                _hp("n_estimators", "int", 200, "Number of trees in the forest.", min=50, max=800, log=True),
                _MAX_DEPTH,
                _MIN_LEAF,
                _hp(
                    "max_features",
                    "categorical",
                    "sqrt",
                    "Features considered at each split. Fewer = more diverse trees.",
                    choices=["sqrt", "log2", 1.0],
                ),
            ],
            supports_class_weight=True,
            tree_based=True,
        ),
        Algorithm(
            "hist_gradient_boosting",
            "Gradient Boosted Trees (scikit-learn)",
            "boosting",
            _ALL,
            _hist_gb,
            [
                _LR,
                _hp("max_iter", "int", 200, "Maximum boosting rounds (early stopping may use fewer).", min=50, max=1000, log=True),
                _hp("max_leaf_nodes", "int", 31, "Maximum leaves per tree; controls tree complexity.", min=8, max=255, log=True),
                _hp("l2_regularization", "float", 0.0, "L2 penalty on leaf values.", min=0.0, max=10.0),
            ],
            supports_class_weight=True,
            tree_based=True,
        ),
        Algorithm(
            "xgboost",
            "XGBoost",
            "boosting",
            _ALL,
            _xgb,
            [
                _N_EST,
                _LR,
                _hp("max_depth", "int", 6, "Maximum depth of each tree.", min=2, max=12),
                _SUBSAMPLE,
                _COLSAMPLE,
                _hp("reg_lambda", "float", 1.0, "L2 regularization on leaf weights.", min=1e-3, max=10, log=True),
            ],
            tree_based=True,
        ),
        Algorithm(
            "lightgbm",
            "LightGBM",
            "boosting",
            _ALL,
            _lgbm,
            [
                _N_EST,
                _LR,
                _hp("num_leaves", "int", 31, "Maximum leaves per tree; the main complexity control in LightGBM.", min=8, max=255, log=True),
                _hp("min_child_samples", "int", 20, "Minimum samples in a leaf.", min=5, max=100, log=True),
                _SUBSAMPLE,
                _COLSAMPLE,
                _hp("reg_lambda", "float", 0.0, "L2 regularization.", min=0.0, max=10.0),
            ],
            supports_class_weight=True,
            tree_based=True,
        ),
        Algorithm(
            "catboost",
            "CatBoost",
            "boosting",
            _ALL,
            _catboost,
            [
                _hp("iterations", "int", 300, "Number of boosting rounds (trees).", min=50, max=1000, log=True),
                _LR,
                _hp("depth", "int", 6, "Depth of the symmetric trees CatBoost grows.", min=2, max=10),
                _hp("l2_leaf_reg", "float", 3.0, "L2 regularization on leaf values.", min=1.0, max=10.0, log=True),
            ],
            supports_class_weight=True,
            tree_based=True,
        ),
        Algorithm(
            "svm",
            "Support Vector Machine",
            "kernel",
            _ALL,
            _svm,
            [
                _hp("C", "float", 1.0, "Penalty for misclassified points. Larger = tighter fit.", min=1e-2, max=100, log=True),
                _hp(
                    "kernel",
                    "categorical",
                    "rbf",
                    "Kernel shape: linear, rbf (radial) or poly (polynomial).",
                    choices=["linear", "rbf", "poly"],
                ),
                _hp("degree", "int", 3, "Polynomial degree (poly kernel only).", min=2, max=5),
            ],
            supports_class_weight=True,
        ),
        Algorithm(
            "mlp",
            "Neural Network (MLP)",
            "neural",
            _ALL,
            _mlp,
            [
                _hp("hidden_units", "int", 64, "Neurons per hidden layer.", min=8, max=256, log=True),
                _hp("hidden_layers", "int", 2, "Number of hidden layers.", min=1, max=4),
                _hp("alpha", "float", 1e-4, "L2 regularization.", min=1e-6, max=1e-1, log=True),
                _hp("learning_rate_init", "float", 1e-3, "Initial learning rate for Adam.", min=1e-4, max=1e-1, log=True),
            ],
        ),
    ]
}

DEFAULT_AUTOML = {
    "binary": ["logistic_regression", "random_forest", "lightgbm", "xgboost"],
    "multiclass": ["logistic_regression", "random_forest", "lightgbm"],
    "regression": ["linear_regression", "random_forest", "lightgbm", "xgboost"],
}


def suggest_params(trial, algorithm: Algorithm) -> dict[str, Any]:
    """Draw hyperparameters from the algorithm's search space (Optuna trial)."""
    params: dict[str, Any] = {}
    for hp in algorithm.hyperparameters:
        if hp.type == "categorical":
            params[hp.name] = trial.suggest_categorical(hp.name, hp.choices)
        elif hp.type == "int":
            params[hp.name] = trial.suggest_int(hp.name, int(hp.min), int(hp.max), log=hp.log)
        elif hp.type == "float":
            params[hp.name] = trial.suggest_float(hp.name, hp.min, hp.max, log=hp.log)
        elif hp.type == "bool":
            params[hp.name] = trial.suggest_categorical(hp.name, [True, False])
    return params


def grid_space(algorithm: Algorithm, points: int = 3) -> dict[str, list[Any]]:
    """A small grid for grid search: choices for categoricals, evenly spaced points for numerics."""
    import numpy as np

    space: dict[str, list[Any]] = {}
    for hp in algorithm.hyperparameters:
        if hp.type == "categorical":
            space[hp.name] = list(hp.choices)
        elif hp.type == "bool":
            space[hp.name] = [True, False]
        else:
            lo, hi = hp.min, hp.max
            values = np.geomspace(lo, hi, points) if hp.log and lo > 0 else np.linspace(lo, hi, points)
            space[hp.name] = sorted({int(round(v)) for v in values}) if hp.type == "int" else [float(v) for v in values]
    return space


# -- ensembles (TRN-005) -------------------------------------------------------------------------------

ENSEMBLE_IDS = ("stacking_ensemble", "voting_ensemble")


def _base_estimators(problem: str, p: dict[str, Any], seed: int) -> list[tuple[str, Any]]:
    return [(b["algorithm"], ALGORITHMS[b["algorithm"]].build(problem, dict(b.get("params") or {}), seed)) for b in p["base"]]


def _stacking(problem, p, seed):
    from sklearn.ensemble import StackingClassifier, StackingRegressor
    from sklearn.linear_model import LogisticRegression, RidgeCV

    if problem in CLASSIFICATION:
        return StackingClassifier(
            _base_estimators(problem, p, seed), final_estimator=LogisticRegression(max_iter=1000), cv=p.get("cv", 3), n_jobs=1
        )
    return StackingRegressor(_base_estimators(problem, p, seed), final_estimator=RidgeCV(), cv=p.get("cv", 3), n_jobs=1)


def _voting(problem, p, seed):
    from sklearn.ensemble import VotingClassifier, VotingRegressor

    if problem in CLASSIFICATION:
        return VotingClassifier(_base_estimators(problem, p, seed), voting="soft", n_jobs=1)
    return VotingRegressor(_base_estimators(problem, p, seed), n_jobs=1)


ENSEMBLES: dict[str, Algorithm] = {
    "stacking_ensemble": Algorithm(
        "stacking_ensemble",
        "Stacking ensemble (best AutoML models + linear meta-model)",
        "ensemble",
        _ALL,
        _stacking,
    ),
    "voting_ensemble": Algorithm(
        "voting_ensemble",
        "Voting ensemble (soft vote / average of the best AutoML models)",
        "ensemble",
        _ALL,
        _voting,
    ),
}


def get_algorithm(algorithm_id: str) -> Algorithm:
    """Resolve any trainable supervised algorithm id, including ensembles (TRN-005)."""
    if algorithm_id in ALGORITHMS:
        return ALGORITHMS[algorithm_id]
    if algorithm_id in ENSEMBLES:
        return ENSEMBLES[algorithm_id]
    raise KeyError(algorithm_id)


def catalog() -> list[AlgorithmInfo]:
    """Every algorithm the studio offers: supervised, ensembles, clustering (TRN-006), forecasting (TRN-007) and
    anomaly detection (TRN-008)."""
    from .anomaly import ANOMALY_ALGORITHMS
    from .clustering import CLUSTERING_ALGORITHMS
    from .forecasting import FORECASTING_ALGORITHMS

    out = [a.info() for a in ALGORITHMS.values()]
    out += [a.info() for a in ENSEMBLES.values()]
    out += [a.info() for a in CLUSTERING_ALGORITHMS.values()]
    out += [a.info() for a in FORECASTING_ALGORITHMS.values()]
    out += [a.info() for a in ANOMALY_ALGORITHMS.values()]
    return out


def known_algorithm(algorithm_id: str) -> bool:
    from .anomaly import ANOMALY_ALGORITHMS
    from .clustering import CLUSTERING_ALGORITHMS
    from .forecasting import FORECASTING_ALGORITHMS

    return (
        algorithm_id in ALGORITHMS
        or algorithm_id in CLUSTERING_ALGORITHMS
        or algorithm_id in FORECASTING_ALGORITHMS
        or algorithm_id in ANOMALY_ALGORITHMS
    )
