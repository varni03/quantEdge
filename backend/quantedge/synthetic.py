"""Synthetic markets for tests and benchmarks. Never used to report research results."""
from __future__ import annotations

import numpy as np
import pandas as pd


def make_market(n_tickers: int = 500, n_days: int = 2520, seed: int = 0,
                start: str = "2014-01-02", signal_strength: float = 0.0):
    """Return (prices, fundamentals). `signal_strength` plants an annual return premium per unit of
    the latent quality characteristic, which is observable through roe."""
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start, periods=n_days)
    tickers = [f"T{i:04d}" for i in range(n_tickers)]
    q = rng.normal(size=n_tickers)
    beta = rng.normal(1.0, 0.3, n_tickers)
    idio = rng.uniform(0.01, 0.025, n_tickers)
    mkt = rng.normal(0.0004, 0.01, n_days)
    r = (mkt[:, None] * beta + signal_strength / 252.0 * q
         + rng.normal(size=(n_days, n_tickers)) * idio)
    prices = pd.DataFrame(100.0 * np.cumprod(1.0 + r, axis=0), index=dates, columns=tickers)

    rows = []
    q_ends = pd.date_range(dates[0] - pd.Timedelta(days=150), dates[-1], freq="QE")
    base_bps = 100.0 * rng.uniform(0.3, 1.2, n_tickers)
    for pe in q_ends:
        lag = rng.integers(35, 61, n_tickers)
        roe = np.clip(0.10 + 0.08 * q + rng.normal(0, 0.02, n_tickers), -0.5, 0.8)
        bps = base_bps * (1.0 + 0.02 * ((pe - q_ends[0]).days / 91.0))
        rows.append(pd.DataFrame({
            "ticker": tickers, "period_end": pe,
            "filed": pe + pd.to_timedelta(lag, unit="D"),
            "book_per_share": bps, "eps_ttm": bps * roe, "roe": roe,
        }))
    fund = pd.concat(rows, ignore_index=True)
    return prices, fund
