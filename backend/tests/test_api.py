import fakeredis
import pytest
from fastapi.testclient import TestClient

from quantedge.api import create_app
from quantedge.cache import MemoryCache, RedisCache


@pytest.fixture
def client(market, ff_for):
    prices, fund = market
    return TestClient(create_app(prices, fund, ff_for, MemoryCache(), "test"))


def test_health(client):
    j = client.get("/api/health").json()
    assert j["status"] == "ok" and j["data_source"] == "test" and j["tickers"] == 60


def test_backtest_returns_metrics_equity_and_ff_alpha(client):
    j = client.post("/api/backtest", json={}).json()
    assert set(j["metrics"]) == {"sharpe", "annual_return", "annual_vol", "max_drawdown", "days"}
    assert j["cached"] is False and len(j["equity"]) > 12 and "alpha_t" in j["ff_alpha"]


def test_second_identical_request_is_served_from_cache(client):
    a = client.post("/api/backtest", json={"quantile": 0.1}).json()
    b = client.post("/api/backtest", json={"quantile": 0.1}).json()
    c = client.post("/api/backtest", json={"quantile": 0.3}).json()
    assert a["cached"] is False and b["cached"] is True and c["cached"] is False
    assert a["metrics"] == b["metrics"] and a["metrics"] != c["metrics"]


def test_date_window_is_respected(client):
    full = client.post("/api/backtest", json={}).json()["metrics"]["days"]
    part = client.post("/api/backtest", json={"start": "2018-01-01"}).json()["metrics"]["days"]
    assert part < full


@pytest.mark.parametrize("body", [{"quantile": 0.9}, {"quantile": 0}, {"cost_bps": -1},
                                  {"momentum": 9}])
def test_invalid_requests_are_rejected(client, body):
    assert client.post("/api/backtest", json=body).status_code == 422


def test_redis_cache_roundtrip_with_ttl(market):
    prices, fund = market
    r = fakeredis.FakeRedis()
    c = TestClient(create_app(prices, fund, None, RedisCache(r, ttl=60), "test"))
    a = c.post("/api/backtest", json={}).json()
    b = c.post("/api/backtest", json={}).json()
    assert a["cached"] is False and b["cached"] is True and "ff_alpha" not in a
    keys = r.keys("quantedge:*")
    assert len(keys) == 1 and 0 < r.ttl(keys[0]) <= 60


def test_memory_cache_expires():
    import time
    c = MemoryCache(ttl=0.01)
    c.set("k", {"a": 1})
    assert c.get("k") == {"a": 1}
    time.sleep(0.03)
    assert c.get("k") is None and c.get("missing") is None


def test_service_starts_from_data_files(tmp_path, monkeypatch, market):
    from quantedge import api
    prices, fund = market
    prices.iloc[:, :30].to_csv(tmp_path / "prices.csv")
    fund[fund["ticker"].isin(prices.columns[:30])].to_csv(tmp_path / "fundamentals.csv", index=False)
    rows = "\n".join(f"{d:%Y%m%d},0.01,0.0,0.0,0.001" for d in prices.index[:300])
    (tmp_path / "ff_daily.csv").write_text(",Mkt-RF,SMB,HML,RF\n" + rows)
    monkeypatch.setenv("QUANTEDGE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("REDIS_URL", raising=False)
    c = TestClient(api._from_env())
    h = c.get("/api/health").json()
    assert h["data_source"] == "files" and h["tickers"] == 30


def test_service_falls_back_to_labelled_synthetic_demo(monkeypatch):
    from quantedge import api
    monkeypatch.delenv("QUANTEDGE_DATA_DIR", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    h = TestClient(api._from_env()).get("/api/health").json()
    assert h["data_source"] == "synthetic-demo"
