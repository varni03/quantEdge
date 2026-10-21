"""Walk-forward selection with a final untouched holdout.

Every configuration in `grid` is a trial. Selection only ever sees returns inside the training
window, the out-of-sample segments are stitched together, and the holdout period is used exactly
once, with the configuration chosen from pre-holdout data only. `n_trials` is reported so that the
number of things tried is visible next to the headline Sharpe ratio.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import product

import pandas as pd

from .backtest import BacktestConfig, run_backtest
from .metrics import sharpe

MIN_TRAIN_DAYS = 126


def default_grid(base: BacktestConfig | None = None,
                 quantiles: tuple[float, ...] = (0.1, 0.2)) -> list[BacktestConfig]:
    base = base or BacktestConfig()
    grid = []
    for m, v, q in product((0, 1), repeat=3):
        if m + v + q == 0:
            continue
        for qt in quantiles:
            grid.append(replace(base, weights=(("momentum", float(m)), ("value", float(v)),
                                               ("quality", float(q))), quantile=qt))
    return grid


@dataclass
class WalkForwardResult:
    oos_returns: pd.Series
    folds: list[dict]
    n_trials: int
    holdout_returns: pd.Series | None
    holdout_config: BacktestConfig | None


def _best(results: dict[BacktestConfig, pd.Series], lo, hi):
    best, best_s = None, float("-inf")
    for cfg, r in results.items():
        seg = r.loc[lo:hi]
        if len(seg) < MIN_TRAIN_DAYS:
            continue
        s = sharpe(seg)
        if s == s and s > best_s:
            best, best_s = cfg, s
    return best, best_s


def walk_forward(prices: pd.DataFrame, fund: pd.DataFrame, grid: list[BacktestConfig],
                 train_years: int = 5, test_years: int = 1,
                 holdout_start: str | pd.Timestamp | None = None) -> WalkForwardResult:
    dev = prices
    if holdout_start is not None:
        holdout_start = pd.Timestamp(holdout_start)
        dev = prices.loc[: holdout_start - pd.Timedelta(days=1)]
    results = {cfg: run_backtest(dev, fund, cfg).returns for cfg in grid}
    first = max(r.index[0] for r in results.values() if len(r))
    last = dev.index[-1]

    folds, oos = [], []
    tr_start = first
    while True:
        tr_end = tr_start + pd.DateOffset(years=train_years)
        te_end = tr_end + pd.DateOffset(years=test_years)
        if te_end > last + pd.Timedelta(days=1):
            break
        cfg, s = _best(results, tr_start, tr_end - pd.Timedelta(days=1))
        if cfg is None:
            break
        seg = results[cfg].loc[tr_end: te_end - pd.Timedelta(days=1)]
        oos.append(seg)
        folds.append({"train_start": tr_start, "train_end": tr_end, "test_end": te_end,
                      "config": cfg, "train_sharpe": s})
        tr_start = tr_start + pd.DateOffset(years=test_years)

    oos_returns = pd.concat(oos) if oos else pd.Series(dtype=float)
    holdout_returns, holdout_cfg = None, None
    if holdout_start is not None:
        holdout_cfg, _ = _best(results, first, last)
        full = run_backtest(prices, fund, holdout_cfg).returns
        holdout_returns = full.loc[holdout_start:]
    return WalkForwardResult(oos_returns, folds, len(grid), holdout_returns, holdout_cfg)
