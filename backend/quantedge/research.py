"""End-to-end research report on real data files: walk-forward OOS, untouched holdout, benchmark.

    python -m quantedge.research --data-dir DATA --holdout 2023-01-01 --benchmark SPY

DATA must contain prices.csv (including the benchmark column), fundamentals.csv and, for the factor
regression, ff_daily.csv. Output is JSON. Every number printed comes from the data you supply.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

import pandas as pd

from . import data, metrics
from .backtest import BacktestConfig
from .regression import ff_alpha
from .walkforward import default_grid, walk_forward


def run(prices: pd.DataFrame, fund: pd.DataFrame, ff: pd.DataFrame | None, benchmark: str,
        holdout: str, cost_bps: float = 10.0, train_years: int = 5, test_years: int = 1,
        long_short: bool = False) -> dict:
    bench = prices[benchmark].pct_change(fill_method=None).dropna()
    universe = prices.drop(columns=[benchmark])
    base = replace(BacktestConfig(), cost_bps=cost_bps, long_short=long_short)
    grid = default_grid(base)
    wf = walk_forward(universe, fund, grid, train_years, test_years, holdout)
    rf = ff["RF"] if ff is not None else 0.0

    def block(r: pd.Series) -> dict:
        b = bench.reindex(r.index).dropna()
        out = {"strategy": metrics.summary(r, rf), "benchmark": metrics.summary(b, rf)}
        if ff is not None:
            out["ff_alpha"] = ff_alpha(r, ff)
        return out

    report = {
        "settings": {"cost_bps": cost_bps, "train_years": train_years, "test_years": test_years,
                     "long_short": long_short, "holdout_start": holdout, "benchmark": benchmark},
        "n_trials": wf.n_trials,
        "walk_forward_oos": block(wf.oos_returns) if len(wf.oos_returns) else None,
        "holdout": block(wf.holdout_returns) if wf.holdout_returns is not None
        and len(wf.holdout_returns) else None,
        "holdout_config": dict(wf.holdout_config.weights) | {"quantile": wf.holdout_config.quantile}
        if wf.holdout_config else None,
        "folds": [{"train_start": str(f["train_start"].date()), "test_end": str(f["test_end"].date()),
                   "weights": dict(f["config"].weights), "quantile": f["config"].quantile,
                   "train_sharpe": round(f["train_sharpe"], 3)} for f in wf.folds],
    }
    return report


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--holdout", required=True, help="first date of the untouched holdout period")
    ap.add_argument("--benchmark", default="SPY")
    ap.add_argument("--cost-bps", type=float, default=10.0)
    ap.add_argument("--train-years", type=int, default=5)
    ap.add_argument("--test-years", type=int, default=1)
    ap.add_argument("--long-short", action="store_true")
    a = ap.parse_args(argv)
    d = Path(a.data_dir)
    ff = data.load_ff_daily(d / "ff_daily.csv") if (d / "ff_daily.csv").exists() else None
    rep = run(data.load_prices_csv(d / "prices.csv"), data.load_fundamentals_csv(d / "fundamentals.csv"),
              ff, a.benchmark, a.holdout, a.cost_bps, a.train_years, a.test_years, a.long_short)
    print(json.dumps(rep, indent=2, default=str))


if __name__ == "__main__":
    main()
