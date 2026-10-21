import numpy as np
import pandas as pd
import pytest

from quantedge import factors


def test_zscore_rows_have_zero_mean_unit_sd_and_ignore_nan():
    rng = np.random.default_rng(0)
    x = pd.DataFrame(rng.normal(size=(5, 40)))
    x.iloc[0, :5] = np.nan
    z = factors.zscore_cs(x, winsor=None)
    assert np.allclose(z.mean(axis=1), 0.0, atol=1e-12)
    assert np.allclose(z.std(axis=1, ddof=1), 1.0)
    assert z.iloc[0, :5].isna().all()


def test_zscore_all_nan_row_is_nan_without_warnings():
    x = pd.DataFrame([[np.nan] * 4, [1.0, 2.0, 3.0, 4.0]])
    z = factors.zscore_cs(x)
    assert z.iloc[0].isna().all() and z.iloc[1].notna().all()


def test_zscore_winsorises():
    x = pd.DataFrame([list(range(30)) + [1e6]])
    assert factors.zscore_cs(x, winsor=3.0).to_numpy().max() <= 3.0


def test_momentum_matches_hand_calculation():
    px = pd.DataFrame({"A": 1.01 ** np.arange(300)})
    m = factors.momentum(px, lookback=252, skip=21)
    assert m["A"].iloc[:252].isna().all()
    assert m["A"].iloc[299] == pytest.approx(1.01 ** (299 - 21) / 1.01 ** (299 - 252) - 1)


def _fund():
    return pd.DataFrame({
        "ticker": ["A", "A"],
        "filed": pd.to_datetime(["2020-02-15", "2020-05-15"]),
        "x": [1.0, 2.0],
    })


def test_point_in_time_uses_filing_date_not_earlier():
    dates = pd.DatetimeIndex(["2020-02-14", "2020-02-15", "2020-05-14", "2020-05-15"])
    out = factors.point_in_time(_fund(), "x", dates, ["A"])
    assert np.isnan(out.loc["2020-02-14", "A"])
    assert out["A"].tolist()[1:] == [1.0, 1.0, 2.0]


def test_point_in_time_lag_shifts_availability():
    dates = pd.DatetimeIndex(["2020-02-19", "2020-02-20"])
    out = factors.point_in_time(_fund(), "x", dates, ["A"], lag_days=5)
    assert np.isnan(out.loc["2020-02-19", "A"]) and out.loc["2020-02-20", "A"] == 1.0


def test_point_in_time_drops_stale_values():
    dates = pd.DatetimeIndex(["2020-06-01", "2022-01-01"])
    out = factors.point_in_time(_fund(), "x", dates, ["A"], max_age_days=550)
    assert out.loc["2020-06-01", "A"] == 2.0 and np.isnan(out.loc["2022-01-01", "A"])


def test_value_prefers_cheaper_names():
    d = pd.DatetimeIndex(["2020-01-31"])
    px = pd.DataFrame([[10.0, 20.0, 40.0]], index=d, columns=list("ABC"))
    bps = pd.DataFrame([[20.0, 20.0, 20.0]], index=d, columns=list("ABC"))
    eps = pd.DataFrame([[2.0, 2.0, 2.0]], index=d, columns=list("ABC"))
    v = factors.value(px, bps, eps).iloc[0]
    assert v["A"] > v["B"] > v["C"]


def test_composite_renormalises_over_available_factors():
    d = pd.DatetimeIndex(["2020-01-31"])
    a = pd.DataFrame([[1.0, 2.0, 3.0, 4.0]], index=d, columns=list("ABCD"))
    b = pd.DataFrame([[4.0, 3.0, 2.0, np.nan]], index=d, columns=list("ABCD"))
    c = factors.composite({"a": a, "b": b}, {"a": 1.0, "b": 1.0}).iloc[0]
    assert c.notna().all()          # D has only factor "a" and still gets a score
    assert c["D"] > 0


def test_composite_rejects_all_zero_weights():
    with pytest.raises(ValueError):
        factors.composite({}, {"a": 0.0})
