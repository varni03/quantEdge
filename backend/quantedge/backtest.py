"""Vectorised factor backtest with month-end rebalancing, drifting weights and trading costs.

Timing convention: signals are computed from data available at the close of rebalance date t, trades
execute at that close, and the new weights first earn the return of day t+1. Costs are charged on the
rebalance date as `cost_bps * turnover`, where turnover is measured against the drifted holdings.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import factors


@dataclass(frozen=True)
class BacktestConfig:
    weights: tuple[tuple[str, float], ...] = (("momentum", 1.0), ("value", 1.0), ("quality", 1.0))
    quantile: float = 0.2
    long_short: bool = False
    cost_bps: float = 10.0
    lag_days: int = 0           # extra delay on top of the filing date for fundamentals
    min_names: int = 20
    mom_lookback: int = 252
    mom_skip: int = 21

    def weight_dict(self) -> dict[str, float]:
        return dict(self.weights)


@dataclass
class BacktestResult:
    returns: pd.Series          # net daily returns, starts at the first invested day
    gross_returns: pd.Series
    turnover: pd.Series         # one-way-sum turnover on each rebalance date
    weights: pd.DataFrame       # target weights on rebalance dates
    config: BacktestConfig = field(repr=False, default=None)


def rebalance_positions(index: pd.DatetimeIndex) -> np.ndarray:
    """Integer positions of the last trading day of every month."""
    s = pd.Series(np.arange(len(index)), index=index)
    return s.groupby([index.year, index.month]).last().to_numpy()


def build_scores(prices: pd.DataFrame, fund: pd.DataFrame, cfg: BacktestConfig,
                 pos: np.ndarray | None = None) -> pd.DataFrame:
    """Composite score on each rebalance date (rows) for each ticker (columns)."""
    if pos is None:
        pos = rebalance_positions(prices.index)
    dates = prices.index[pos]
    tickers = list(prices.columns)
    w = cfg.weight_dict()
    sig: dict[str, pd.DataFrame] = {}
    if w.get("momentum", 0):
        sig["momentum"] = factors.momentum(prices, cfg.mom_lookback, cfg.mom_skip).iloc[pos]
    px_at = prices.iloc[pos]
    if w.get("value", 0):
        bps = factors.point_in_time(fund, "book_per_share", dates, tickers, cfg.lag_days)
        eps = factors.point_in_time(fund, "eps_ttm", dates, tickers, cfg.lag_days)
        sig["value"] = factors.value(px_at, bps, eps)
    if w.get("quality", 0):
        sig["quality"] = factors.quality(factors.point_in_time(fund, "roe", dates, tickers,
                                                              cfg.lag_days))
    scores = factors.composite(sig, w)
    return scores.where(px_at.notna())


def target_weights(scores: pd.DataFrame, cfg: BacktestConfig) -> pd.DataFrame:
    """Equal-weight the top (and optionally bottom) quantile of each cross-section.

    Long-only weights sum to 1. Long-short is dollar neutral with +0.5 / -0.5 (gross exposure 1).
    """
    s = scores.to_numpy(dtype=float)
    out = np.zeros_like(s)
    side = 0.5 if cfg.long_short else 1.0
    for i in range(s.shape[0]):
        row = s[i]
        valid = np.flatnonzero(~np.isnan(row))
        if valid.size < cfg.min_names:
            continue
        k = max(1, int(np.floor(cfg.quantile * valid.size)))
        order = valid[np.argsort(row[valid], kind="stable")]
        out[i, order[-k:]] = side / k
        if cfg.long_short:
            out[i, order[:k]] = -side / k
    return pd.DataFrame(out, index=scores.index, columns=scores.columns)


def run_backtest(prices: pd.DataFrame, fund: pd.DataFrame,
                 cfg: BacktestConfig = BacktestConfig()) -> BacktestResult:
    pos = rebalance_positions(prices.index)
    scores = build_scores(prices, fund, cfg, pos)
    tw = target_weights(scores, cfg)
    return simulate(prices, tw, pos, cfg)


def simulate(prices: pd.DataFrame, tw: pd.DataFrame, pos: np.ndarray,
             cfg: BacktestConfig) -> BacktestResult:
    R = prices.pct_change(fill_method=None).fillna(0.0).to_numpy()
    T, n = R.shape
    tgt = {int(p): tw.iloc[i].to_numpy() for i, p in enumerate(pos)}
    w = np.zeros(n)
    net = np.zeros(T)
    gross = np.zeros(T)
    turn = {}
    rate = cfg.cost_bps * 1e-4
    for t in range(T):
        r = R[t]
        rp = float(w @ r)
        denom = 1.0 + rp
        if denom > 0:
            w = w * (1.0 + r) / denom
        gross[t] = rp
        if t in tgt:
            new = tgt[t]
            tv = float(np.abs(new - w).sum())
            turn[prices.index[t]] = tv
            rp -= rate * tv
            w = new.copy()
        net[t] = rp
    idx = prices.index
    active = np.flatnonzero(np.abs(net) > 0)
    start = int(active[0]) if active.size else T
    return BacktestResult(
        returns=pd.Series(net, index=idx).iloc[start:],
        gross_returns=pd.Series(gross, index=idx).iloc[start:],
        turnover=pd.Series(turn, dtype=float),
        weights=tw,
        config=cfg,
    )
