import numpy as np
import pandas as pd
import pytest

from quantedge.backtest import BacktestConfig, run_backtest, target_weights
from quantedge.metrics import sharpe
from quantedge.synthetic import make_market

QUALITY_ONLY = (("momentum", 0.0), ("value", 0.0), ("quality", 1.0))


def _tiny(roe_rows, cost_bps=0.0):
    """4 tickers, Jan to Mar 2020, flat-ish deterministic prices, quality-only strategy."""
    dates = pd.bdate_range("2020-01-02", "2020-03-31")
    rng = np.random.default_rng(5)
    rets = rng.normal(0.0005, 0.01, (len(dates), 4))
    prices = pd.DataFrame(100 * np.cumprod(1 + rets, axis=0), index=dates, columns=list("WXYZ"))
    fund = pd.DataFrame(roe_rows, columns=["ticker", "filed", "roe"])
    fund["filed"] = pd.to_datetime(fund["filed"])
    fund["period_end"] = fund["filed"] - pd.Timedelta(days=40)
    fund["book_per_share"] = 10.0
    fund["eps_ttm"] = 1.0
    cfg = BacktestConfig(weights=QUALITY_ONLY, quantile=0.25, min_names=4, cost_bps=cost_bps)
    return prices, fund, cfg


BASE = [("W", "2019-12-20", 0.05), ("X", "2019-12-20", 0.30),
        ("Y", "2019-12-20", 0.10), ("Z", "2019-12-20", 0.02)]


def test_zero_cost_returns_equal_the_selected_stock():
    prices, fund, cfg = _tiny(BASE)
    res = run_backtest(prices, fund, cfg)
    expected = prices["X"].pct_change().loc["2020-02-03":]   # first rebalance is 2020-01-31
    assert res.returns.index[0] == pd.Timestamp("2020-02-03")
    assert np.allclose(res.returns.to_numpy(), expected.to_numpy())


def test_first_trade_cost_is_bps_times_turnover():
    prices, fund, cfg = _tiny(BASE, cost_bps=10.0)
    res = run_backtest(prices, fund, cfg)
    assert res.turnover[pd.Timestamp("2020-01-31")] == pytest.approx(1.0)
    assert res.returns.iloc[0] == pytest.approx(-0.001)
    assert res.returns.index[0] == pd.Timestamp("2020-01-31")


def test_no_trade_when_holdings_unchanged():
    prices, fund, cfg = _tiny(BASE, cost_bps=10.0)
    res = run_backtest(prices, fund, cfg)
    assert res.turnover[pd.Timestamp("2020-02-28")] == pytest.approx(0.0, abs=1e-12)


def test_switching_names_costs_two_units_of_turnover():
    rows = BASE + [("X", "2020-02-10", 0.01), ("Y", "2020-02-10", 0.50)]
    prices, fund, cfg = _tiny(rows, cost_bps=10.0)
    res = run_backtest(prices, fund, cfg)
    assert res.turnover[pd.Timestamp("2020-02-28")] == pytest.approx(2.0)
    assert (res.gross_returns - res.returns).loc["2020-02-28"] == pytest.approx(0.002)


def test_weights_long_only_sum_to_one_and_long_short_is_dollar_neutral(market):
    prices, fund = market
    from quantedge.backtest import build_scores
    cfg = BacktestConfig()
    scores = build_scores(prices, fund, cfg)
    tw = target_weights(scores, cfg)
    invested = tw[(tw != 0).any(axis=1)]
    assert len(invested) > 10 and np.allclose(invested.sum(axis=1), 1.0)
    tw_ls = target_weights(scores, BacktestConfig(long_short=True))
    inv = tw_ls[(tw_ls != 0).any(axis=1)]
    assert np.allclose(inv.sum(axis=1), 0.0)
    assert np.allclose(inv.abs().sum(axis=1), 1.0)


def test_future_prices_do_not_change_past_returns(market):
    """Look-ahead check: scrambling every price after day T must not move any result before T."""
    prices, fund = market
    T = 900
    rng = np.random.default_rng(1)
    shocked = prices.copy()
    shocked.iloc[T:] = shocked.iloc[T:] * rng.uniform(0.5, 2.0, shocked.iloc[T:].shape)
    cfg = BacktestConfig()
    a = run_backtest(prices, fund, cfg).returns
    b = run_backtest(shocked, fund, cfg).returns
    cut = prices.index[T - 1]
    assert np.allclose(a.loc[:cut], b.loc[:cut])


def test_future_filings_do_not_change_past_returns(market):
    prices, fund = market
    cut = prices.index[900]
    future_changed = fund.copy()
    mask = future_changed["filed"] > cut
    future_changed.loc[mask, "roe"] = -future_changed.loc[mask, "roe"] * 3
    future_changed.loc[mask, "eps_ttm"] = future_changed.loc[mask, "eps_ttm"] * -2
    cfg = BacktestConfig()
    a = run_backtest(prices, fund, cfg).returns
    b = run_backtest(prices, future_changed, cfg).returns
    assert np.allclose(a.loc[:cut], b.loc[:cut])


def test_filing_lag_changes_results_only_when_filings_are_in_play(market):
    prices, fund = market
    a = run_backtest(prices, fund, BacktestConfig()).returns
    b = run_backtest(prices, fund, BacktestConfig(lag_days=30)).returns
    assert not np.allclose(a.loc[b.index[0]:].to_numpy()[:200], b.to_numpy()[:200])


def test_planted_signal_is_detected_and_null_is_not():
    cfg = BacktestConfig(weights=QUALITY_ONLY, long_short=True, cost_bps=0.0)
    p, f = make_market(100, 1500, seed=2, signal_strength=1.0)
    assert sharpe(run_backtest(p, f, cfg).returns) > 1.0
    p0, f0 = make_market(100, 1500, seed=2, signal_strength=0.0)
    assert abs(sharpe(run_backtest(p0, f0, cfg).returns)) < 1.0


def test_costs_never_increase_net_return(market):
    prices, fund = market
    free = run_backtest(prices, fund, BacktestConfig(cost_bps=0.0)).returns
    paid = run_backtest(prices, fund, BacktestConfig(cost_bps=25.0)).returns
    assert (1 + paid).prod() < (1 + free).prod()
