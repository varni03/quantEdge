"""Factor signals. Every function is vectorised and uses only information available at each date."""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd


def zscore_cs(x: pd.DataFrame, winsor: float | None = 3.0) -> pd.DataFrame:
    """Cross-sectional z-score per row (date), ignoring NaN, optionally winsorised."""
    a = x.to_numpy(dtype=float)
    with warnings.catch_warnings(), np.errstate(invalid="ignore", divide="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN rows are expected
        mu = np.nanmean(a, axis=1, keepdims=True)
        sd = np.nanstd(a, axis=1, ddof=1, keepdims=True)
        z = (a - mu) / np.where(sd > 0, sd, np.nan)
    if winsor is not None:
        z = np.clip(z, -winsor, winsor)
    return pd.DataFrame(z, index=x.index, columns=x.columns)


def momentum(prices: pd.DataFrame, lookback: int = 252, skip: int = 21) -> pd.DataFrame:
    """12-1 momentum: return from t-lookback to t-skip (skips the most recent month)."""
    return prices.shift(skip) / prices.shift(lookback) - 1.0


def point_in_time(fund: pd.DataFrame, field: str, dates: pd.DatetimeIndex,
                  tickers: list[str], lag_days: int = 0,
                  max_age_days: int | None = 550) -> pd.DataFrame:
    """Latest value of `field` that was public on each date.

    A value filed on day F is usable from F + lag_days onward (lag_days adds a safety margin on top
    of the filing date). Values older than `max_age_days` are dropped as stale.
    """
    f = fund[["ticker", "filed", field]].dropna().copy()
    f["avail"] = f["filed"] + pd.Timedelta(days=lag_days)
    f = f.sort_values(["ticker", "avail"]).drop_duplicates(["ticker", "avail"], keep="last")
    vals = f.pivot(index="avail", columns="ticker", values=field)
    ages = f.pivot(index="avail", columns="ticker", values="avail")
    grid = vals.index.union(dates)
    vals = vals.reindex(grid).ffill().reindex(dates)
    ages = ages.reindex(grid).ffill().reindex(dates)
    if max_age_days is not None:
        a_np = ages.to_numpy()
        d_np = dates.to_numpy().astype(a_np.dtype)
        age_days = (d_np[:, None] - a_np) / np.timedelta64(1, "D")
        vals = vals.where(age_days <= max_age_days)
    return vals.reindex(columns=tickers)


def value(prices_at: pd.DataFrame, bps: pd.DataFrame, eps: pd.DataFrame) -> pd.DataFrame:
    """Average of cross-sectional z(book/price) and z(earnings/price)."""
    px = prices_at.where(prices_at > 0)
    bp = zscore_cs(bps / px)
    ep = zscore_cs(eps / px)
    n = bp.notna().astype(float) + ep.notna().astype(float)
    return (bp.fillna(0.0) + ep.fillna(0.0)) / n.where(n > 0)


def quality(roe: pd.DataFrame) -> pd.DataFrame:
    return zscore_cs(roe)


def composite(signals: dict[str, pd.DataFrame], weights: dict[str, float]) -> pd.DataFrame:
    """Weighted mean of z-scores, renormalised over the factors available for each name."""
    names = [k for k, w in weights.items() if w != 0]
    if not names:
        raise ValueError("at least one factor weight must be non-zero")
    num = 0.0
    den = 0.0
    for k in names:
        z = zscore_cs(signals[k])
        w = float(weights[k])
        num = num + z.fillna(0.0) * w
        den = den + z.notna().astype(float) * abs(w)
    out = num / den.where(den > 0)
    return out
