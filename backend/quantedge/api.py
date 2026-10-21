"""FastAPI service. Run: `uvicorn quantedge.api:app`.

Data comes from QUANTEDGE_DATA_DIR (prices.csv, fundamentals.csv, optional ff_daily.csv). Without it
the service starts on a small synthetic market and says so in every response (`data_source`).
Set REDIS_URL to cache responses in Redis; otherwise an in-process TTL cache is used.
"""
from __future__ import annotations

import hashlib
import os
import time
from dataclasses import replace
from datetime import date
from pathlib import Path

import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

from . import data, metrics
from .backtest import BacktestConfig, run_backtest
from .cache import MemoryCache, RedisCache
from .regression import ff_alpha
from .synthetic import make_market


class BacktestRequest(BaseModel):
    momentum: float = Field(1.0, ge=0, le=5)
    value: float = Field(1.0, ge=0, le=5)
    quality: float = Field(1.0, ge=0, le=5)
    quantile: float = Field(0.2, gt=0, le=0.5)
    long_short: bool = False
    cost_bps: float = Field(10.0, ge=0, le=200)
    start: date | None = None
    end: date | None = None


def create_app(prices: pd.DataFrame, fund: pd.DataFrame, ff: pd.DataFrame | None = None,
               cache=None, data_source: str = "files") -> FastAPI:
    app = FastAPI(title="QuantEdge", version="0.1.0")
    cache = cache if cache is not None else MemoryCache()

    @app.get("/api/health")
    def health():
        return {"status": "ok", "data_source": data_source, "tickers": prices.shape[1],
                "first": str(prices.index[0].date()), "last": str(prices.index[-1].date())}

    @app.post("/api/backtest")
    def backtest(req: BacktestRequest):
        t0 = time.perf_counter()
        key = hashlib.sha256((req.model_dump_json() + data_source).encode()).hexdigest()
        hit = cache.get(key)
        if hit is not None:
            hit["cached"] = True
            hit["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 3)
            return hit
        cfg = replace(BacktestConfig(), quantile=req.quantile, long_short=req.long_short,
                      cost_bps=req.cost_bps,
                      weights=(("momentum", req.momentum), ("value", req.value),
                               ("quality", req.quality)))
        px = prices.loc[pd.Timestamp(req.start) if req.start else None:
                        pd.Timestamp(req.end) if req.end else None]
        res = run_backtest(px, fund, cfg)
        rf = ff["RF"] if ff is not None else 0.0
        out = {
            "data_source": data_source,
            "metrics": metrics.summary(res.returns, rf),
            "avg_turnover": float(res.turnover.mean()) if len(res.turnover) else 0.0,
            "equity": [[str(d.date()), float(v)] for d, v in
                       (1.0 + res.returns).cumprod().resample("ME").last().items()],
            "cached": False,
        }
        if ff is not None:
            out["ff_alpha"] = ff_alpha(res.returns, ff)
        out["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 3)
        cache.set(key, out)
        return out

    return app


def _from_env() -> FastAPI:
    d = os.environ.get("QUANTEDGE_DATA_DIR")
    ff = None
    if d and (Path(d) / "prices.csv").exists():
        prices = data.load_prices_csv(Path(d) / "prices.csv")
        fund = data.load_fundamentals_csv(Path(d) / "fundamentals.csv")
        if (Path(d) / "ff_daily.csv").exists():
            ff = data.load_ff_daily(Path(d) / "ff_daily.csv")
        source = "files"
    else:
        prices, fund = make_market(n_tickers=200, n_days=2000, seed=1, signal_strength=0.0)
        source = "synthetic-demo"
    cache = None
    if os.environ.get("REDIS_URL"):
        import redis
        cache = RedisCache(redis.Redis.from_url(os.environ["REDIS_URL"]))
    return create_app(prices, fund, ff, cache, source)


app = _from_env()
