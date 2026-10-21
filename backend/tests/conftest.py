import numpy as np
import pandas as pd
import pytest

from quantedge.synthetic import make_market


@pytest.fixture(scope="session")
def market():
    return make_market(n_tickers=60, n_days=1300, seed=7, signal_strength=0.0)


@pytest.fixture(scope="session")
def long_market():
    return make_market(n_tickers=60, n_days=2520, seed=11, signal_strength=0.0)


@pytest.fixture(scope="session")
def ff_for(market):
    prices, _ = market
    rng = np.random.default_rng(3)
    idx = prices.index
    return pd.DataFrame({
        "Mkt-RF": rng.normal(0.0003, 0.01, len(idx)),
        "SMB": rng.normal(0.0, 0.004, len(idx)),
        "HML": rng.normal(0.0, 0.004, len(idx)),
        "RF": np.full(len(idx), 0.00005),
    }, index=idx)
