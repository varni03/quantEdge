import numpy as np
import pandas as pd
import pytest
import statsmodels.api as sm

from quantedge.regression import ff_alpha, ols_hac


def _data(n=800, seed=0):
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n, 3)) * 0.01
    e = rng.normal(size=n) * 0.005
    for t in range(1, n):          # autocorrelated errors so HAC matters
        e[t] += 0.4 * e[t - 1]
    y = 0.0002 + X @ np.array([1.1, 0.3, -0.2]) + e
    return y, X


def test_ols_hac_matches_statsmodels():
    y, X = _data()
    mine = ols_hac(y, X, lags=6)
    ref = sm.OLS(y, sm.add_constant(X)).fit(cov_type="HAC", cov_kwds={"maxlags": 6})
    assert np.allclose(mine["beta"], ref.params)
    assert np.allclose(mine["se"], ref.bse, rtol=1e-8)
    assert mine["r2"] == pytest.approx(ref.rsquared)


def test_default_lag_rule():
    y, X = _data(n=800)
    assert ols_hac(y, X)["lags"] == int(np.floor(4 * (800 / 100) ** (2 / 9)))


def test_needs_more_observations_than_regressors():
    with pytest.raises(ValueError):
        ols_hac(np.arange(3.0), np.ones((3, 3)))


def test_ff_alpha_recovers_planted_alpha_and_loadings():
    rng = np.random.default_rng(4)
    idx = pd.bdate_range("2018-01-01", periods=1500)
    ff = pd.DataFrame({"Mkt-RF": rng.normal(0.0003, 0.01, len(idx)),
                       "SMB": rng.normal(0, 0.004, len(idx)),
                       "HML": rng.normal(0, 0.004, len(idx)), "RF": 0.00004}, index=idx)
    strat = (ff["RF"] + 0.0003 + 1.1 * ff["Mkt-RF"] + 0.3 * ff["SMB"] - 0.2 * ff["HML"]
             + rng.normal(0, 0.0005, len(idx)))
    out = ff_alpha(strat, ff)
    assert out["alpha_daily"] == pytest.approx(0.0003, abs=5e-5)
    assert out["alpha_annual"] == pytest.approx(out["alpha_daily"] * 252)
    assert out["loadings"]["Mkt-RF"] == pytest.approx(1.1, abs=0.02)
    assert out["loadings"]["SMB"] == pytest.approx(0.3, abs=0.05)
    assert out["loadings"]["HML"] == pytest.approx(-0.2, abs=0.05)
    assert out["alpha_t"] > 3


def test_ff_alpha_on_pure_noise_is_not_significant():
    rng = np.random.default_rng(9)
    idx = pd.bdate_range("2018-01-01", periods=1500)
    ff = pd.DataFrame({"Mkt-RF": rng.normal(0.0003, 0.01, len(idx)),
                       "SMB": rng.normal(0, 0.004, len(idx)),
                       "HML": rng.normal(0, 0.004, len(idx)), "RF": 0.00004}, index=idx)
    strat = pd.Series(rng.normal(0.00004, 0.01, len(idx)), index=idx)
    assert abs(ff_alpha(strat, ff)["alpha_t"]) < 3
