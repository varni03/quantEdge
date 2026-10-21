"""Performance statistics on daily simple returns."""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def sharpe(r: pd.Series, rf: pd.Series | float = 0.0) -> float:
    ex = r - (rf.reindex(r.index).fillna(0.0) if isinstance(rf, pd.Series) else rf)
    sd = ex.std(ddof=1)
    if not np.isfinite(sd) or sd < 1e-12:      # constant series: Sharpe is undefined, not huge
        return float("nan")
    return float(ex.mean() / sd * np.sqrt(TRADING_DAYS))


def max_drawdown(r: pd.Series) -> float:
    """Largest peak-to-trough fall of the wealth curve (a negative number)."""
    wealth = (1.0 + r).cumprod()
    peak = np.maximum.accumulate(wealth.to_numpy())
    return float((wealth.to_numpy() / peak - 1.0).min())


def annual_return(r: pd.Series) -> float:
    n = len(r)
    return float((1.0 + r).prod() ** (TRADING_DAYS / n) - 1.0) if n else float("nan")


def annual_vol(r: pd.Series) -> float:
    return float(r.std(ddof=1) * np.sqrt(TRADING_DAYS))


def summary(r: pd.Series, rf: pd.Series | float = 0.0) -> dict[str, float]:
    return {
        "sharpe": sharpe(r, rf),
        "annual_return": annual_return(r),
        "annual_vol": annual_vol(r),
        "max_drawdown": max_drawdown(r),
        "days": int(len(r)),
    }
