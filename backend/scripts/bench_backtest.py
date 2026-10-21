"""Timing benchmark on a SYNTHETIC 500-ticker, 10-year market (2520 trading days).

It measures engine speed only. Synthetic data says nothing about returns; do not quote Sharpe from
this script. Run: python scripts/bench_backtest.py
"""
from __future__ import annotations

import json
import platform
import statistics
import time

import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

from quantedge.api import create_app
from quantedge.backtest import BacktestConfig, run_backtest
from quantedge.cache import MemoryCache
from quantedge.synthetic import make_market


def cpu_model() -> str:
    try:
        for ln in open("/proc/cpuinfo"):
            if ln.startswith("model name"):
                return ln.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def main(runs: int = 7, n_cached: int = 300) -> dict:
    prices, fund = make_market(500, 2520, seed=0)
    cfg = BacktestConfig()
    run_backtest(prices, fund, cfg)                      # warm-up
    times = []
    for _ in range(runs):
        t = time.perf_counter()
        run_backtest(prices, fund, cfg)
        times.append(time.perf_counter() - t)

    client = TestClient(create_app(prices, fund, None, MemoryCache(), "bench"))
    t = time.perf_counter()
    cold = client.post("/api/backtest", json={}).json()
    cold_ms = (time.perf_counter() - t) * 1000
    lat = []
    for _ in range(n_cached):
        t = time.perf_counter()
        r = client.post("/api/backtest", json={})
        lat.append((time.perf_counter() - t) * 1000)
        assert r.json()["cached"] is True
    out = {
        "universe": {"tickers": 500, "trading_days": 2520, "data": "synthetic"},
        "backtest_seconds": {"runs": runs, "median": round(statistics.median(times), 3),
                             "min": round(min(times), 3), "max": round(max(times), 3)},
        "api_uncached_ms_first_call": round(cold_ms, 1),
        "api_cached_ms": {"n": n_cached, "p50": round(pct(lat, 50), 2),
                          "p95": round(pct(lat, 95), 2), "p99": round(pct(lat, 99), 2)},
        "env": {"cpu": cpu_model(), "cores": __import__("os").cpu_count(),
                "python": platform.python_version(), "numpy": np.__version__,
                "pandas": pd.__version__},
        "note": "cached latency is in-process via FastAPI TestClient, not over a network socket",
    }
    return out


if __name__ == "__main__":
    print(json.dumps(main(), indent=2))
