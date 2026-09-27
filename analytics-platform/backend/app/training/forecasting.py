"""Time-series forecasting (MDL-002a, TRN-007, EXP-004).

A forecasting experiment names a ``time_column``, a numeric ``target`` and a ``horizon``. Rows are aggregated onto a
regular grid (frequency auto-detected), then each algorithm is evaluated with a rolling-origin backtest
(time-series cross-validation). Algorithms:

* ``seasonal_naive``: repeat the last season (the baseline every other model must beat; MASE < 1 means better).
* ``exponential_smoothing``: ETS / Holt-Winters (statsmodels), analytic prediction intervals.
* ``sarima``: seasonal ARIMA (statsmodels SARIMAX), analytic prediction intervals.
* ``gbm_forecast``: LightGBM on lag, rolling-window and calendar features, forecasting recursively; intervals from
  out-of-sample residual quantiles, widened with √step.

Metrics: MAE, RMSE, MASE, sMAPE, and prediction-interval coverage. Artifacts carry the history, every backtest
window and the future forecast with intervals, ready to plot. A per-series ``group_column`` is P2 and not supported.
"""

from __future__ import annotations

import logging
import math
import time
import warnings
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from .algorithms import Algorithm, _hp

if TYPE_CHECKING:  # pragma: no cover
    from ..schema.model import Schema
    from .trainer import TrainingConfig, TrainingResult

log = logging.getLogger("app.training.forecasting")

MAX_HISTORY = 2000  # points kept in the model artifact (and used for refits with fresh history)
PLOT_HISTORY = 500


class ForecastConfig(BaseModel):
    """TRN-007 options. ``frequency`` is a pandas offset alias (``D``, ``W-SUN``, ``MS``, ``h`` …); empty = detect."""

    time_column: str
    frequency: str | None = None
    horizon: int = Field(default=12, ge=1, le=1000)
    season_length: int | None = Field(default=None, ge=1, le=1000)
    backtest_folds: int = Field(default=3, ge=1, le=20)
    interval_level: float = Field(default=0.9, ge=0.5, le=0.99)
    aggregation: Literal["mean", "sum", "last"] = "mean"
    group_column: str | None = None  # P2: one model per series


# -- forecasters -------------------------------------------------------------------------------------------


def _z(level: float) -> float:
    from scipy.stats import norm

    return float(norm.ppf(0.5 + level / 2))


class Forecaster:
    """Fit on a regular series, forecast ``h`` steps with a central prediction interval."""

    def __init__(self, params: dict[str, Any], season: int, freq: str, seed: int = 0):
        self.params = dict(params)
        self.season = season
        self.freq = freq
        self.seed = seed

    def fit(self, y: pd.Series) -> Forecaster:  # pragma: no cover - interface
        raise NotImplementedError

    def forecast(self, h: int, level: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:  # pragma: no cover
        raise NotImplementedError


class SeasonalNaive(Forecaster):
    def fit(self, y: pd.Series) -> SeasonalNaive:
        self.y_ = y.to_numpy(dtype=float)
        m = self.season if len(self.y_) > self.season else 1
        self.m_ = m
        resid = self.y_[m:] - self.y_[:-m]
        self.sigma_ = float(np.sqrt(np.mean(resid**2))) if len(resid) > 1 else 0.0  # RMSE: bias widens the interval
        return self

    def forecast(self, h: int, level: float):
        m = self.m_
        last = self.y_[-m:]
        mean = np.array([last[k % m] for k in range(h)])
        width = _z(level) * self.sigma_ * np.sqrt(np.arange(h) // m + 1)
        return mean, mean - width, mean + width


class ExponentialSmoothingForecaster(Forecaster):
    def fit(self, y: pd.Series) -> ExponentialSmoothingForecaster:
        from statsmodels.tsa.exponential_smoothing.ets import ETSModel

        p = self.params
        seasonal = p.get("seasonal") if self.season > 1 and len(y) >= 2 * self.season + 2 else None
        trend = p.get("trend")
        self.n_ = len(y)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.res_ = ETSModel(
                pd.Series(y.to_numpy(dtype=float)),
                error="add",
                trend=trend,
                damped_trend=bool(p.get("damped_trend")) and trend is not None,
                seasonal=seasonal,
                seasonal_periods=self.season if seasonal else None,
            ).fit(disp=False, maxiter=200)
        return self

    def forecast(self, h: int, level: float):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sf = self.res_.get_prediction(start=self.n_, end=self.n_ + h - 1).summary_frame(alpha=1 - level)
        return sf["mean"].to_numpy(), sf["pi_lower"].to_numpy(), sf["pi_upper"].to_numpy()


class SarimaForecaster(Forecaster):
    def fit(self, y: pd.Series) -> SarimaForecaster:
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        p = self.params
        order = tuple(p.get("order", (1, 1, 1)))
        seasonal = tuple(p.get("seasonal_order", (0, 1, 1)))
        m = self.season if self.season > 1 and len(y) >= 2 * self.season + 4 else 0
        seasonal_order = (*seasonal, m) if m else (0, 0, 0, 0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.res_ = SARIMAX(
                y.to_numpy(dtype=float),
                order=order,
                seasonal_order=seasonal_order,
                trend=p.get("trend"),
                enforce_stationarity=False,
                enforce_invertibility=False,
            ).fit(disp=False, maxiter=100)
        return self

    def forecast(self, h: int, level: float):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sf = self.res_.get_forecast(h).summary_frame(alpha=1 - level)
        return sf["mean"].to_numpy(), sf["mean_ci_lower"].to_numpy(), sf["mean_ci_upper"].to_numpy()


class GBMForecaster(Forecaster):
    """Gradient boosting on lags, rolling means and calendar features, applied recursively."""

    def _lags(self) -> list[int]:
        m = self.season
        lags = {1, 2, 3}
        if m > 1:
            lags |= {m}
        return sorted(lag for lag in lags if lag < max(4, self.n_ // 3))

    def _features(self, values: np.ndarray, stamps: pd.DatetimeIndex, t: int) -> list[float]:
        """Features for predicting position ``t`` from ``values[:t]``."""
        row = [values[t - lag] for lag in self.lags_]
        for w in self.windows_:
            row.append(float(np.mean(values[t - w : t])))
        ts = stamps[t]
        row += [ts.month, ts.dayofweek, ts.dayofyear, ts.hour]
        return row

    def _matrix(self, values: np.ndarray, stamps: pd.DatetimeIndex, start: int) -> tuple[np.ndarray, np.ndarray]:
        rows = [self._features(values, stamps, t) for t in range(start, len(values))]
        return np.asarray(rows, dtype=float), values[start:]

    def _model(self):
        import lightgbm as lgb

        p = self.params
        return lgb.LGBMRegressor(
            n_estimators=int(p.get("n_estimators", 200)),
            learning_rate=float(p.get("learning_rate", 0.05)),
            num_leaves=int(p.get("num_leaves", 15)),
            min_child_samples=5,
            random_state=self.seed,
            n_jobs=2,
            verbose=-1,
        )

    def fit(self, y: pd.Series) -> GBMForecaster:
        self.n_ = len(y)
        self.difference_ = bool(self.params.get("difference", False))
        raw = y.to_numpy(dtype=float)
        values = np.diff(raw, prepend=raw[0]) if self.difference_ else raw
        self.lags_ = self._lags()
        self.windows_ = sorted({w for w in (3, self.season) if 1 < w < max(4, self.n_ // 3)})
        self.start_ = max([*self.lags_, *self.windows_, 1]) + (1 if self.difference_ else 0)
        stamps = pd.DatetimeIndex(y.index)
        X, target = self._matrix(values, stamps, self.start_)
        if len(X) < 8:
            raise ValueError("series too short for the gradient-boosting forecaster")
        # Out-of-sample one-step residuals (last 25% held out) give the interval quantiles.
        cut = max(4, int(len(X) * 0.75))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            holdout = self._model().fit(X[:cut], target[:cut])
            resid = target[cut:] - holdout.predict(X[cut:])
            self.model_ = self._model().fit(X, target)
        self.resid_ = resid if len(resid) >= 3 else target - self.model_.predict(X)
        self.values_, self.raw_last_, self.stamps_ = values, float(raw[-1]), stamps
        return self

    def forecast(self, h: int, level: float):
        values = list(self.values_)
        stamps = self.stamps_.append(future_index(self.stamps_[-1], self.freq, h))
        steps = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for _ in range(h):
                t = len(values)
                x = np.asarray([self._features(np.asarray(values), stamps, t)], dtype=float)
                v = float(self.model_.predict(x)[0])
                values.append(v)
                steps.append(v)
        steps_arr = np.asarray(steps)
        mean = self.raw_last_ + np.cumsum(steps_arr) if self.difference_ else steps_arr
        lo_q, hi_q = np.quantile(self.resid_, [(1 - level) / 2, 1 - (1 - level) / 2])
        scale = np.sqrt(np.arange(1, h + 1))
        return mean, mean + lo_q * scale, mean + hi_q * scale


_FORECASTERS: dict[str, type[Forecaster]] = {
    "seasonal_naive": SeasonalNaive,
    "exponential_smoothing": ExponentialSmoothingForecaster,
    "sarima": SarimaForecaster,
    "gbm_forecast": GBMForecaster,
}

# AutoML search spaces (evaluated by backtest MASE), in the order they are tried.
SEARCH_SPACES: dict[str, list[dict[str, Any]]] = {
    "seasonal_naive": [{}],
    "exponential_smoothing": [
        {"trend": "add", "damped_trend": True, "seasonal": "add"},
        {"trend": None, "damped_trend": False, "seasonal": "add"},
        {"trend": "add", "damped_trend": False, "seasonal": None},
        {"trend": None, "damped_trend": False, "seasonal": None},
    ],
    "sarima": [
        {"order": [0, 1, 1], "seasonal_order": [0, 1, 1]},
        {"order": [1, 1, 1], "seasonal_order": [0, 1, 1]},
        {"order": [1, 0, 0], "seasonal_order": [1, 1, 0], "trend": "c"},
        {"order": [2, 1, 1], "seasonal_order": [0, 0, 0]},
    ],
    "gbm_forecast": [
        {"difference": False, "learning_rate": 0.05, "n_estimators": 200},
        {"difference": True, "learning_rate": 0.05, "n_estimators": 200},
        {"difference": False, "learning_rate": 0.1, "n_estimators": 100, "num_leaves": 7},
    ],
}


def _build(name: str) -> Callable[[str, dict[str, Any], int], Any]:
    return lambda problem, params, seed: _FORECASTERS[name](params, 1, "D", seed)


FORECASTING_ALGORITHMS: dict[str, Algorithm] = {
    "seasonal_naive": Algorithm(
        "seasonal_naive", "Seasonal naive (baseline)", "forecasting", ("forecasting",), _build("seasonal_naive"), []
    ),
    "exponential_smoothing": Algorithm(
        "exponential_smoothing",
        "Exponential smoothing (ETS / Holt-Winters)",
        "forecasting",
        ("forecasting",),
        _build("exponential_smoothing"),
        [
            _hp("trend", "categorical", "add", "Trend component: none or additive.", choices=[None, "add"]),
            _hp("damped_trend", "bool", True, "Flatten the trend over long horizons (usually more accurate)."),
            _hp("seasonal", "categorical", "add", "Seasonal component: none or additive.", choices=[None, "add"]),
        ],
    ),
    "sarima": Algorithm(
        "sarima",
        "SARIMA (seasonal ARIMA)",
        "forecasting",
        ("forecasting",),
        _build("sarima"),
        [
            _hp("order", "categorical", [1, 1, 1], "(p, d, q): autoregressive terms, differencing, moving-average terms.", choices=None),
            _hp(
                "seasonal_order", "categorical", [0, 1, 1], "(P, D, Q) of the seasonal part; the period is the season length.", choices=None
            ),
        ],
    ),
    "gbm_forecast": Algorithm(
        "gbm_forecast",
        "Gradient boosting on lag features (LightGBM)",
        "forecasting",
        ("forecasting",),
        _build("gbm_forecast"),
        [
            _hp("difference", "bool", False, "Model period-over-period changes (helps with trends trees can't extrapolate)."),
            _hp("learning_rate", "float", 0.05, "Shrinkage per boosting round.", min=0.01, max=0.3, log=True),
            _hp("n_estimators", "int", 200, "Boosting rounds.", min=50, max=1000, log=True),
        ],
    ),
}
DEFAULT_FORECASTING = ["seasonal_naive", "exponential_smoothing", "sarima", "gbm_forecast"]


# -- series preparation ----------------------------------------------------------------------------------------


_SEASONS = {"D": 7, "B": 5, "W": 52, "M": 12, "MS": 12, "ME": 12, "SM": 24, "SMS": 24, "Q": 4, "QS": 4, "QE": 4, "h": 24, "H": 24}


def season_for(freq: str) -> int:
    from pandas.tseries.frequencies import to_offset

    try:
        name = to_offset(freq).name
    except ValueError:
        return 1
    base = name.split("-")[0]
    base = "".join(ch for ch in base if not ch.isdigit()) or base
    if base in ("min", "T"):
        return 60
    return _SEASONS.get(base, 1)


def detect_frequency(stamps: pd.DatetimeIndex) -> str:
    """pandas' inferred frequency, falling back to the median spacing (monthly/weekly/daily/hourly…)."""
    from pandas.tseries.frequencies import to_offset

    stamps = stamps.sort_values().unique()
    if len(stamps) < 3:
        raise ValueError("need at least three distinct timestamps to detect a frequency")
    inferred = pd.infer_freq(stamps)
    if inferred:
        return to_offset(inferred).freqstr
    delta = pd.Series(stamps).diff().dropna().median()
    days = delta / pd.Timedelta(days=1)
    if 27 <= days <= 32:
        return "MS" if (pd.DatetimeIndex(stamps).day == 1).mean() > 0.5 else "ME"
    if 88 <= days <= 93:
        return "QS" if (pd.DatetimeIndex(stamps).day == 1).mean() > 0.5 else "QE"
    if 360 <= days <= 367:
        return "YS"
    return to_offset(delta).freqstr


def future_index(last: pd.Timestamp, freq: str, h: int) -> pd.DatetimeIndex:
    return pd.date_range(start=last, periods=h + 1, freq=freq)[1:]


def prepare_series(frame: pd.DataFrame, target: str, cfg: ForecastConfig) -> tuple[pd.Series, str, list[str]]:
    """Aggregate to a regular grid at the detected frequency; interpolate gaps."""
    from .trainer import TrainingError

    if cfg.time_column not in frame.columns:
        raise TrainingError(f"time column {cfg.time_column!r} not found")
    if target not in frame.columns:
        raise TrainingError(f"target column {target!r} not found")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        stamps = pd.to_datetime(frame[cfg.time_column], errors="coerce", format="mixed")
    if getattr(stamps.dt, "tz", None) is not None:
        stamps = stamps.dt.tz_convert("UTC").dt.tz_localize(None)
    values = pd.to_numeric(frame[target], errors="coerce")
    if values.notna().sum() < 3 or not (pd.api.types.is_numeric_dtype(frame[target]) or values.notna().mean() > 0.9):
        raise TrainingError("forecasting needs a numeric target")
    data = pd.DataFrame({"t": stamps, "y": values}).dropna(subset=["t"])
    warns: list[str] = []
    grouped = data.groupby("t")["y"].agg(cfg.aggregation).sort_index()
    if len(grouped) < len(data):
        warns.append(f"{len(data) - len(grouped)} rows share a timestamp and were aggregated ({cfg.aggregation})")
    try:
        freq = cfg.frequency or detect_frequency(pd.DatetimeIndex(grouped.index))
        series = grouped.resample(freq).agg(cfg.aggregation if cfg.aggregation != "last" else "last")
    except (ValueError, TypeError) as exc:
        raise TrainingError(f"can't build a regular series: {exc}") from exc
    if cfg.aggregation == "sum":
        series = series.where(grouped.resample(freq).count() > 0)  # empty periods are gaps, not zeros
    gaps = int(series.isna().sum())
    if gaps:
        warns.append(f"{gaps} missing periods were interpolated")
        series = series.interpolate(limit_direction="both")
    series = series.astype(float)
    series.index = pd.DatetimeIndex(series.index)
    return series, freq, warns


# -- metrics (EXP-004) --------------------------------------------------------------------------------------------


def forecast_metrics(windows: list[dict[str, Any]], season: int) -> dict[str, Any]:
    """MAE, RMSE, MASE (scaled by the in-sample seasonal-naive error), sMAPE (%) and interval coverage."""
    actual = np.concatenate([w["actual_arr"] for w in windows])
    pred = np.concatenate([w["forecast_arr"] for w in windows])
    lower = np.concatenate([w["lower_arr"] for w in windows])
    upper = np.concatenate([w["upper_arr"] for w in windows])
    err = actual - pred
    scales = [w["scale"] for w in windows if w["scale"] > 0]
    scale = float(np.mean(scales)) if scales else float("nan")
    denom = np.abs(actual) + np.abs(pred)
    smape = float(np.mean(np.where(denom > 0, 2 * np.abs(err) / np.where(denom > 0, denom, 1), 0.0)) * 100)
    finite = np.isfinite(lower) & np.isfinite(upper)
    return {
        "mae": _r(np.mean(np.abs(err))),
        "rmse": _r(math.sqrt(float(np.mean(err**2)))),
        "mase": _r(np.mean(np.abs(err)) / scale) if scale and math.isfinite(scale) else None,
        "smape": _r(smape),
        "coverage": _r(np.mean((actual >= lower) & (actual <= upper))) if finite.any() else None,
        "interval_width": _r(np.mean(upper[finite] - lower[finite])) if finite.any() else None,
        "n_backtest_points": int(len(actual)),
        "folds": len(windows),
    }


def _r(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else round(f, 6)


def _naive_scale(train: np.ndarray, season: int) -> float:
    m = season if len(train) > season + 1 else 1
    diffs = np.abs(train[m:] - train[:-m])
    return float(diffs.mean()) if len(diffs) else 0.0


def backtest(
    algo_id: str, params: dict[str, Any], series: pd.Series, origins: list[int], h: int, season: int, freq: str, level: float, seed: int
) -> list[dict[str, Any]]:
    """Rolling-origin evaluation: fit on everything before each origin, forecast the next ``h`` points."""
    windows = []
    for origin in origins:
        train, test = series.iloc[:origin], series.iloc[origin : origin + h]
        model = _FORECASTERS[algo_id](params, season, freq, seed).fit(train)
        mean, lower, upper = model.forecast(len(test), level)
        windows.append(
            {
                "origin": train.index[-1].isoformat(),
                "timestamps": [t.isoformat() for t in test.index],
                "actual_arr": test.to_numpy(dtype=float),
                "forecast_arr": np.asarray(mean, dtype=float),
                "lower_arr": np.asarray(lower, dtype=float),
                "upper_arr": np.asarray(upper, dtype=float),
                "scale": _naive_scale(train.to_numpy(dtype=float), season),
            }
        )
    return windows


def _window_json(w: dict[str, Any]) -> dict[str, Any]:
    return {
        "origin": w["origin"],
        "timestamps": w["timestamps"],
        "actual": [_r(v) for v in w["actual_arr"]],
        "forecast": [_r(v) for v in w["forecast_arr"]],
        "lower": [_r(v) for v in w["lower_arr"]],
        "upper": [_r(v) for v in w["upper_arr"]],
    }


# -- the served model -------------------------------------------------------------------------------------------


class ForecastModel:
    """The artifact of a forecasting run: a fitted forecaster plus the series it was trained on."""

    def __init__(self, algorithm: str, params: dict[str, Any], series: pd.Series, freq: str, season: int, level: float, seed: int):
        self.algorithm = algorithm
        self.params = params
        self.series = series.iloc[-MAX_HISTORY:]
        self.freq = freq
        self.season = season
        self.level = level
        self.seed = seed
        self.forecaster = _FORECASTERS[algorithm](params, season, freq, seed).fit(series)

    def forecast(self, horizon: int, history: pd.Series | None = None) -> dict[str, Any]:
        """Future timestamps, point forecasts and intervals. Fresh ``history`` is merged in and the model refit with
        the same hyperparameters."""
        forecaster, series = self.forecaster, self.series
        if history is not None and len(history):
            series = history.combine_first(self.series).sort_index()
            series = series.resample(self.freq).mean().interpolate(limit_direction="both").iloc[-MAX_HISTORY:]
            forecaster = _FORECASTERS[self.algorithm](self.params, self.season, self.freq, self.seed).fit(series)
        mean, lower, upper = forecaster.forecast(horizon, self.level)
        stamps = future_index(series.index[-1], self.freq, horizon)
        return {
            "timestamps": [t.isoformat() for t in stamps],
            "predictions": [_r(v) for v in mean],
            "lower": [_r(v) for v in lower],
            "upper": [_r(v) for v in upper],
            "interval_level": self.level,
        }


def parse_history(rows: list[dict[str, Any]], time_column: str, target: str) -> pd.Series:
    """Recent observations sent with a forecast request: ``[{time_column|timestamp: …, target|value: …}]``."""
    stamps, values = [], []
    for row in rows:
        stamp = row.get(time_column, row.get("timestamp"))
        value = row.get(target, row.get("value"))
        if stamp is None or value is None:
            raise ValueError(f"history rows need {time_column!r} (or 'timestamp') and {target!r} (or 'value')")
        stamps.append(stamp)
        values.append(value)
    try:
        index = pd.DatetimeIndex(pd.to_datetime(stamps, format="mixed"))
        if index.tz is not None:
            index = index.tz_convert("UTC").tz_localize(None)
        s = pd.Series(pd.to_numeric(values, errors="raise"), index=index, dtype=float)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"invalid history: {exc}") from exc
    return s.groupby(level=0).mean().sort_index()


# -- detection (MDL-002a) ----------------------------------------------------------------------------------------


def detect_time_series(frame: pd.DataFrame, target: str) -> dict[str, Any] | None:
    """Suggest forecasting when the target is numeric and a date column indexes (mostly) one row per period."""
    from .preprocessing import _looks_like_dates

    if target not in frame or not pd.api.types.is_numeric_dtype(frame[target]) or pd.api.types.is_bool_dtype(frame[target]):
        return None
    for col in frame.columns:
        if col == target:
            continue
        s = frame[col]
        if not (pd.api.types.is_datetime64_any_dtype(s) or (not pd.api.types.is_numeric_dtype(s) and _looks_like_dates(s))):
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            stamps = pd.to_datetime(s, errors="coerce", format="mixed").dropna()
        if len(stamps) < 12 or stamps.nunique() < 0.5 * len(stamps):
            continue
        try:
            freq = detect_frequency(pd.DatetimeIndex(stamps))
        except ValueError:
            continue
        return {
            "problem_type": "forecasting",
            "time_column": col,
            "frequency": freq,
            "reason": f"{col!r} is a regular {freq} time index with (almost) one row per period",
        }
    return None


# -- training ------------------------------------------------------------------------------------------------------


def _origins(n: int, h: int, folds: int, minimum: int) -> list[int]:
    origins = [n - h * (folds - i) for i in range(folds)]
    return [o for o in origins if o >= minimum]


def train_forecast(
    frame: pd.DataFrame, config: TrainingConfig, schema: Schema | None = None, *, progress: Callable[[float, str], None] | None = None
) -> TrainingResult:
    from .trainer import AlgorithmResult, TrainingError, TrainingResult

    started = time.monotonic()
    deadline = started + config.max_training_seconds
    report = progress or (lambda f, m: None)
    cfg = config.forecast
    assert cfg is not None and config.target
    if cfg.group_column:
        raise TrainingError("per-series forecasting (group_column) is not supported yet")
    series, freq, warns = prepare_series(frame, config.target, cfg)
    n = len(series)
    if n < 12:
        raise TrainingError("forecasting needs at least 12 periods of history")
    season = cfg.season_length or season_for(freq)
    if season > 1 and n < 2 * season + cfg.horizon:
        warns.append(f"only {n} periods: too short for seasonality {season}; fitting without a seasonal component")
        season = 1
    h_bt = min(cfg.horizon, max(1, n // 4))
    if h_bt < cfg.horizon:
        warns.append(f"backtest windows use a {h_bt}-step horizon (the series is short)")
    minimum = max(8, 2 * season + 2)
    origins = _origins(n, h_bt, cfg.backtest_folds, minimum)
    if not origins:
        raise TrainingError(f"the series ({n} periods) is too short for a backtest with horizon {h_bt}")

    candidates = [a for a in (config.algorithms or DEFAULT_FORECASTING) if a in FORECASTING_ALGORITHMS]
    if not candidates:
        raise TrainingError("none of the selected algorithms supports forecasting")
    level = cfg.interval_level
    results: list[AlgorithmResult] = []
    for i, algo_id in enumerate(candidates):
        if time.monotonic() > deadline and results:
            warns.append(f"time budget reached; skipped {', '.join(candidates[i:])}")
            break
        report(0.05 + 0.8 * i / len(candidates), f"backtesting {FORECASTING_ALGORITHMS[algo_id].name}")
        t0 = time.monotonic()
        override = config.hyperparameters.get(algo_id, {})
        space = [{**p, **override} for p in SEARCH_SPACES[algo_id]]
        if config.automl.enabled:
            space = space[: max(1, math.ceil(config.automl.n_trials / len(candidates)))]
        else:
            space = space[:1]
        trials: list[dict[str, Any]] = []
        best: tuple[float, dict[str, Any], list[dict[str, Any]], dict[str, Any]] | None = None
        budget_end = t0 + config.automl.timeout_seconds / len(candidates)
        for params in space:
            if trials and time.monotonic() > min(budget_end, deadline):
                break
            try:
                windows = backtest(algo_id, params, series, origins, h_bt, season, freq, level, config.seed)
            except Exception as exc:  # noqa: BLE001 - a candidate that fails to fit is skipped
                trials.append({"params": params, "error": str(exc)[:200]})
                continue
            m = forecast_metrics(windows, season)
            score = -(m["mase"] if m["mase"] is not None else (m["rmse"] or math.inf))
            trials.append({"params": params, "cv_score": score, **{k: m[k] for k in ("mae", "rmse", "mase", "smape", "coverage")}})
            if best is None or score > best[0]:
                best = (score, params, windows, m)
        if best is None:
            warns.append(f"{FORECASTING_ALGORITHMS[algo_id].name} failed: {trials[-1].get('error') if trials else 'no candidates'}")
            continue
        score, params, windows, m = best
        try:
            model = ForecastModel(algo_id, params, series, freq, season, level, config.seed)
            future = model.forecast(cfg.horizon)
        except Exception as exc:  # noqa: BLE001
            warns.append(f"{FORECASTING_ALGORITHMS[algo_id].name} failed on the full series: {str(exc)[:200]}")
            continue
        tail = series.iloc[-PLOT_HISTORY:]
        artifacts = {
            "history": {"timestamps": [t.isoformat() for t in tail.index], "values": [_r(v) for v in tail]},
            "backtest": [_window_json(w) for w in windows],
            "forecast": {k: future[k] for k in ("timestamps", "lower", "upper", "interval_level")} | {"forecast": future["predictions"]},
            "frequency": freq,
            "season_length": season,
        }
        results.append(
            AlgorithmResult(
                algorithm=algo_id,
                params=params,
                cv_score=score if math.isfinite(score) else -1e12,
                cv_std=0.0,
                metrics={
                    **m,
                    "horizon": cfg.horizon,
                    "cv_score": score if math.isfinite(score) else None,
                    "cv_std": 0.0,
                    "cv_metric": "mase",
                },
                artifacts=artifacts,
                pipeline=model,
                duration_seconds=time.monotonic() - t0,
                trials=[t for t in trials],
            )
        )
    if not results:
        raise TrainingError("no forecasting algorithm could be fitted to this series")
    best_index = int(np.argmax([r.cv_score for r in results]))
    signature = {
        "target": config.target,
        "problem_type": "forecasting",
        "classes": None,
        "features": [],
        "time_column": cfg.time_column,
        "frequency": freq,
        "season_length": season,
        "horizon": cfg.horizon,
        "interval_level": level,
        "last_timestamp": series.index[-1].isoformat(),
    }
    report(0.95, "done")
    return TrainingResult(
        problem_type="forecasting",
        scoring="mase",
        classes=None,
        results=results,
        best_index=best_index,
        signature=signature,
        warnings=warns,
        background=pd.DataFrame(),
        reference=None,
    )
