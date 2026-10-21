import numpy as np
import pandas as pd

from quantedge.backtest import BacktestConfig
from quantedge.walkforward import default_grid, walk_forward

HOLDOUT = "2021-06-01"


def test_default_grid_counts_every_trial():
    g = default_grid()
    assert len(g) == 14 and len(set(g)) == 14       # 7 factor subsets x 2 quantiles


def test_folds_and_holdout_do_not_overlap(long_market):
    prices, fund = long_market
    wf = walk_forward(prices, fund, default_grid(), train_years=3, test_years=1,
                      holdout_start=HOLDOUT)
    assert wf.n_trials == 14 and len(wf.folds) >= 2
    tests = [(f["train_end"], f["test_end"]) for f in wf.folds]
    assert all(tests[i][1] <= tests[i + 1][1] for i in range(len(tests) - 1))
    assert all(f["train_end"] <= pd.Timestamp(HOLDOUT) for f in wf.folds)
    assert wf.oos_returns.index.max() < pd.Timestamp(HOLDOUT)
    assert wf.holdout_returns.index.min() >= pd.Timestamp(HOLDOUT)
    assert not wf.oos_returns.index.has_duplicates


def test_selection_never_sees_the_holdout(long_market):
    """Scrambling holdout prices must not change any fold choice or the holdout configuration."""
    prices, fund = long_market
    base = walk_forward(prices, fund, default_grid(), 3, 1, HOLDOUT)
    rng = np.random.default_rng(2)
    shocked = prices.copy()
    mask = shocked.index >= pd.Timestamp(HOLDOUT)
    shocked.loc[mask] = shocked.loc[mask] * rng.uniform(0.5, 2.0, shocked.loc[mask].shape)
    alt = walk_forward(shocked, fund, default_grid(), 3, 1, HOLDOUT)
    assert [f["config"] for f in alt.folds] == [f["config"] for f in base.folds]
    assert alt.holdout_config == base.holdout_config
    assert np.allclose(alt.oos_returns.to_numpy(), base.oos_returns.to_numpy())


def test_walk_forward_without_holdout(long_market):
    prices, fund = long_market
    wf = walk_forward(prices, fund, default_grid(BacktestConfig(), quantiles=(0.2,)), 3, 1)
    assert wf.holdout_returns is None and wf.holdout_config is None and len(wf.oos_returns) > 0
