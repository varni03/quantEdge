"""Data loading.

Prices:        wide CSV, first column is the date, other columns are tickers (adjusted close).
Fundamentals:  long CSV with columns ticker, period_end, filed, book_per_share, eps_ttm, roe.
               `filed` is the date the filing became public (the SEC acceptance date), which is
               what the backtest keys on. Never use `period_end` for availability.
Fama-French:   Ken French daily 3-factor CSV, as downloaded (percent units).
"""
from __future__ import annotations

import re
from io import StringIO
from pathlib import Path

import pandas as pd

FUND_COLS = ["ticker", "period_end", "filed", "book_per_share", "eps_ttm", "roe"]
_DATE8 = re.compile(r"^\s*\d{8}\s*,")


def load_prices_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, index_col=0, parse_dates=True).sort_index()
    if df.index.has_duplicates:
        raise ValueError("duplicate dates in price file")
    return df.astype(float)


def load_fundamentals_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["period_end", "filed"])
    missing = set(FUND_COLS) - set(df.columns)
    if missing:
        raise ValueError(f"fundamentals file missing columns: {sorted(missing)}")
    if (df["filed"] < df["period_end"]).any():
        raise ValueError("found filings dated before their period end")
    return df.sort_values(["ticker", "filed"]).reset_index(drop=True)


def load_ff_daily(src: str | Path) -> pd.DataFrame:
    """Parse the Ken French daily 3-factor file. `src` is a path or the raw text.

    Returns decimals (the file is in percent) with columns Mkt-RF, SMB, HML, RF.
    """
    if isinstance(src, Path) or (isinstance(src, str) and "\n" not in src and Path(src).exists()):
        text = Path(src).read_text()
    else:
        text = str(src)
    rows = [ln for ln in text.splitlines() if _DATE8.match(ln)]
    if not rows:
        raise ValueError("no daily rows found in Fama-French file")
    df = pd.read_csv(StringIO("\n".join(rows)), header=None,
                     names=["date", "Mkt-RF", "SMB", "HML", "RF"], index_col=0)
    df.index = pd.to_datetime(df.index.astype(str), format="%Y%m%d")
    return (df.astype(float) / 100.0).sort_index()
