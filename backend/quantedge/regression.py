"""OLS with Newey-West (Bartlett kernel) standard errors, and the Fama-French alpha regression."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .metrics import TRADING_DAYS


def ols_hac(y: np.ndarray, X: np.ndarray, lags: int | None = None) -> dict:
    """Regress y on X (a constant is added). Returns coefficients, HAC standard errors, t-stats."""
    y = np.asarray(y, dtype=float)
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X[:, None]
    n = len(y)
    Z = np.column_stack([np.ones(n), X])
    k = Z.shape[1]
    if n <= k:
        raise ValueError("need more observations than regressors")
    ZtZ_inv = np.linalg.inv(Z.T @ Z)
    beta = ZtZ_inv @ Z.T @ y
    e = y - Z @ beta
    L = int(np.floor(4 * (n / 100.0) ** (2.0 / 9.0))) if lags is None else lags
    u = Z * e[:, None]
    S = u.T @ u
    for lag in range(1, L + 1):
        G = u[lag:].T @ u[:-lag]
        S += (1.0 - lag / (L + 1.0)) * (G + G.T)
    cov = ZtZ_inv @ S @ ZtZ_inv
    se = np.sqrt(np.diag(cov))
    ss_res = float(e @ e)
    ss_tot = float(((y - y.mean()) ** 2).sum())
    return {"beta": beta, "se": se, "t": beta / se, "r2": 1.0 - ss_res / ss_tot, "n": n, "lags": L}


def ff_alpha(strategy: pd.Series, ff: pd.DataFrame, lags: int | None = None) -> dict:
    """Regress strategy excess returns on Mkt-RF, SMB, HML. Alpha is reported daily and annualised."""
    df = pd.concat([strategy.rename("r"), ff], axis=1, join="inner").dropna()
    y = (df["r"] - df["RF"]).to_numpy()
    X = df[["Mkt-RF", "SMB", "HML"]].to_numpy()
    fit = ols_hac(y, X, lags)
    return {
        "alpha_daily": float(fit["beta"][0]),
        "alpha_annual": float(fit["beta"][0] * TRADING_DAYS),
        "alpha_t": float(fit["t"][0]),
        "loadings": dict(zip(["Mkt-RF", "SMB", "HML"], fit["beta"][1:].tolist())),
        "r2": float(fit["r2"]),
        "n": int(fit["n"]),
        "lags": int(fit["lags"]),
    }
