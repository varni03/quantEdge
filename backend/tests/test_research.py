import json

import numpy as np
import pandas as pd

from quantedge import research


def _files(tmp_path, long_market):
    prices, fund = long_market
    rng = np.random.default_rng(0)
    prices = prices.copy()
    prices["SPY"] = 100 * np.cumprod(1 + rng.normal(0.0004, 0.01, len(prices)))
    prices.to_csv(tmp_path / "prices.csv")
    fund.to_csv(tmp_path / "fundamentals.csv", index=False)
    rows = "\n".join(f"{d:%Y%m%d},{rng.normal(0.03, 1):.4f},{rng.normal(0, .4):.4f},"
                     f"{rng.normal(0, .4):.4f},0.002" for d in prices.index)
    (tmp_path / "ff_daily.csv").write_text(",Mkt-RF,SMB,HML,RF\n" + rows)
    return prices, fund


def test_research_report_end_to_end(tmp_path, long_market, capsys):
    _files(tmp_path, long_market)
    research.main(["--data-dir", str(tmp_path), "--holdout", "2021-06-01",
                   "--train-years", "3", "--cost-bps", "10"])
    rep = json.loads(capsys.readouterr().out)
    assert rep["n_trials"] == 14 and rep["settings"]["cost_bps"] == 10.0
    assert rep["walk_forward_oos"]["strategy"]["days"] > 200
    assert rep["holdout"]["strategy"]["days"] > 100
    assert "alpha_t" in rep["holdout"]["ff_alpha"]
    assert set(rep["holdout_config"]) == {"momentum", "value", "quality", "quantile"}
    assert len(rep["folds"]) >= 2


def test_research_without_ff_file(tmp_path, long_market):
    prices, fund = _files(tmp_path, long_market)
    (tmp_path / "ff_daily.csv").unlink()
    rep = research.run(prices, fund, None, "SPY", "2021-06-01", train_years=3)
    assert "ff_alpha" not in rep["holdout"] and rep["holdout"]["benchmark"]["days"] > 100
