import numpy as np
import pandas as pd
import pytest

from quantedge import metrics


def s(x):
    return pd.Series(x, index=pd.bdate_range("2020-01-01", periods=len(x)))


def test_sharpe_matches_formula():
    r = s([0.01, -0.01, 0.02, 0.0])
    expected = 0.005 / np.std([0.01, -0.01, 0.02, 0.0], ddof=1) * np.sqrt(252)
    assert metrics.sharpe(r) == pytest.approx(expected)


def test_sharpe_uses_excess_return():
    r = s([0.01, 0.02, 0.03])
    assert metrics.sharpe(r, rf=0.01) == pytest.approx(
        np.mean([0, 0.01, 0.02]) / np.std([0, 0.01, 0.02], ddof=1) * np.sqrt(252))


def test_sharpe_zero_vol_is_nan():
    assert np.isnan(metrics.sharpe(s([0.001] * 10)))


def test_max_drawdown_known_paths():
    assert metrics.max_drawdown(s([0.1, -0.5, 0.2])) == pytest.approx(-0.5)
    assert metrics.max_drawdown(s([0.1, 0.1, 0.1])) == pytest.approx(0.0)
    # peak 1.21, trough 1.21*0.9*0.9 = 0.9801 -> -19%
    assert metrics.max_drawdown(s([0.1, 0.1, -0.1, -0.1])) == pytest.approx(0.81 - 1.0)


def test_annual_return_and_vol():
    assert metrics.annual_return(s([0.001] * 252)) == pytest.approx(1.001 ** 252 - 1)
    r = s([0.01, -0.01] * 50)
    assert metrics.annual_vol(r) == pytest.approx(r.std(ddof=1) * np.sqrt(252))


def test_summary_keys():
    out = metrics.summary(s(list(np.random.default_rng(0).normal(0, 0.01, 100))))
    assert set(out) == {"sharpe", "annual_return", "annual_vol", "max_drawdown", "days"}
