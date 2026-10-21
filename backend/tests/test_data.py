import pandas as pd
import pytest

from quantedge import data

FF_SAMPLE = """This file was created by CMPT_ME_BEME_RETS using the 202409 CRSP database.

,Mkt-RF,SMB,HML,RF
20240102,  -0.10,  1.00,   0.50, 0.021
20240103,   0.20, -0.30,   0.10, 0.021

 Annual Factors: January-December
 
2023,  25.0, -3.0, -10.0, 5.0
"""


def test_ff_parser_returns_decimals_and_skips_header_and_annual_rows():
    ff = data.load_ff_daily(FF_SAMPLE)
    assert list(ff.columns) == ["Mkt-RF", "SMB", "HML", "RF"]
    assert len(ff) == 2
    assert ff.loc["2024-01-02", "SMB"] == pytest.approx(0.01)
    assert ff.loc["2024-01-03", "RF"] == pytest.approx(0.00021)


def test_ff_parser_reads_a_file(tmp_path):
    p = tmp_path / "ff.csv"
    p.write_text(FF_SAMPLE)
    assert len(data.load_ff_daily(p)) == 2


def test_ff_parser_rejects_empty():
    with pytest.raises(ValueError):
        data.load_ff_daily("nothing here")


def test_prices_loader(tmp_path):
    p = tmp_path / "p.csv"
    p.write_text("date,A,B\n2020-01-03,2,3\n2020-01-02,1,2\n")
    df = data.load_prices_csv(p)
    assert df.index.is_monotonic_increasing and df.loc["2020-01-02", "A"] == 1.0


def test_prices_loader_rejects_duplicate_dates(tmp_path):
    p = tmp_path / "p.csv"
    p.write_text("date,A\n2020-01-02,1\n2020-01-02,2\n")
    with pytest.raises(ValueError):
        data.load_prices_csv(p)


def _fund_csv(tmp_path, rows):
    df = pd.DataFrame(rows, columns=["ticker", "period_end", "filed", "book_per_share",
                                     "eps_ttm", "roe"])
    p = tmp_path / "f.csv"
    df.to_csv(p, index=False)
    return p


def test_fundamentals_loader_ok(tmp_path):
    p = _fund_csv(tmp_path, [["A", "2019-12-31", "2020-02-20", 10, 1, 0.1]])
    assert len(data.load_fundamentals_csv(p)) == 1


def test_fundamentals_loader_rejects_filing_before_period_end(tmp_path):
    p = _fund_csv(tmp_path, [["A", "2019-12-31", "2019-11-01", 10, 1, 0.1]])
    with pytest.raises(ValueError):
        data.load_fundamentals_csv(p)


def test_fundamentals_loader_rejects_missing_columns(tmp_path):
    p = tmp_path / "f.csv"
    p.write_text("ticker,filed\nA,2020-01-01\n")
    with pytest.raises(ValueError):
        data.load_fundamentals_csv(p)
