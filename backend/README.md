# quantEdge research service (v2 Python backend)

A vectorised factor research and backtesting engine with a FastAPI layer. It is the "Python quant
service" that `V2.md` defers from the TypeScript dashboard: Fama-French style regressions and
vectorised backtesting, kept in Python because that is where the numerics belong.

**This README reports only what was measured. It contains no strategy performance numbers.** Research
results depend on the data you supply; produce them with `quantedge.research` (below) and record
what it prints.

## What it does

- **Factors** (`factors.py`): 12-1 momentum, value (book/price and earnings/price), quality (ROE),
  cross-sectional z-scores with winsorisation, composite score renormalised over available factors.
- **Point-in-time fundamentals** (`factors.point_in_time`): a value is usable only from the date it was
  *filed*, plus an optional extra lag, and is dropped once stale. Period-end dates are never used.
- **Backtest** (`backtest.py`): month-end rebalance, equal-weight top (and optionally bottom)
  quantile, drifting weights, costs charged as `bps x turnover` against the drifted holdings.
  Signals use the close of day t, trades fill at that close, new weights first earn day t+1.
- **Walk-forward with a holdout** (`walkforward.py`): configuration is chosen only on the training
  window, out-of-sample segments are stitched together, and the holdout is used once with a
  configuration chosen from pre-holdout data. `n_trials` (14 by default) is reported with every result.
- **Regression** (`regression.py`): OLS with Newey-West standard errors, and a Fama-French 3-factor
  alpha with its t-statistic.
- **API** (`api.py`): `POST /api/backtest`, `GET /api/health`; responses cached in Redis
  (`REDIS_URL`) or an in-process TTL cache.

## Run it

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest --cov=quantedge                      # tests
uvicorn quantedge.api:app                   # API; starts on a labelled synthetic demo without data
python scripts/bench_backtest.py            # timing benchmark (synthetic data)
```

### Producing real research numbers

Put these in a directory and point `--data-dir` at it:

| file | contents |
| --- | --- |
| `prices.csv` | date index, one adjusted-close column per ticker, plus the benchmark (e.g. `SPY`) |
| `fundamentals.csv` | `ticker, period_end, filed, book_per_share, eps_ttm, roe` (`filed` = SEC acceptance date) |
| `ff_daily.csv` | Ken French "Fama/French 3 Factors [Daily]" CSV, as downloaded |

```bash
python -m quantedge.research --data-dir data --holdout 2023-01-01 --benchmark SPY --cost-bps 10
```

It prints walk-forward out-of-sample and holdout statistics (Sharpe net of costs, annual return,
volatility, max drawdown) for the strategy and the benchmark, the Fama-French alpha with its
t-statistic, `n_trials`, and every fold's chosen configuration.

## Verification (measured)

- **57 tests, 98% line coverage** of the `quantedge` package (`pytest --cov=quantedge`).
- Correctness checks include: a hand-computed 4-stock portfolio (returns, first-trade cost,
  zero-turnover rebalance, a two-unit switch); OLS and Newey-West standard errors against
  `statsmodels`; Fama-French regression recovering a planted alpha and loadings; max drawdown and
  Sharpe on known paths.
- **Look-ahead tests**: scrambling every price after day T, or every filing made after T, leaves
  all results before T unchanged; scrambling the holdout leaves every walk-forward choice unchanged.
- A planted-signal market is detected (Sharpe > 1) and a null market is not.

## Performance (measured, synthetic data)

500 tickers x 2,520 trading days (10 years), default configuration, 2 vCPU Intel Xeon 2.8 GHz,
Python 3.13, NumPy 2.5.3, pandas 3.0.5:

| measurement | result |
| --- | --- |
| full backtest, 7 runs | median 0.187 s (min 0.171, max 0.192) |
| API first call, uncached | 212 ms |
| API repeated call, cached (300 calls) | p50 3.1 ms, p95 4.7 ms, p99 5.1 ms |

Cached latency is in-process through FastAPI's `TestClient`, not over a network socket. The data is
synthetic, so this measures engine speed only. Loading real CSVs is extra.

## Known limitations

- **Survivorship and data quality are the data's problem.** The engine can be no better than the
  constituents, delisting treatment and filing dates you give it. A current-constituents universe
  overstates results.
- Delisted names simply stop contributing (return 0 after their last price); there is no delisting-return model.
- Costs are a flat bps charge on turnover. There is no market impact, borrow cost or capacity model.
- Equal weights, monthly rebalance, one-day execution lag: a research baseline, not a production system.
- The 14-trial grid is small, but selection on any grid inflates the headline Sharpe; read the
  holdout, not the walk-forward, as the cleaner estimate, and treat a t-statistic near 2 as weak.
- Redis caching is tested against `fakeredis`, not a live Redis server.
