/**
 * Core numeric types for the quant engine.
 *
 * Everything in `lib/quant` is pure: no React, no database, no network. That is what
 * makes it directly unit-testable, and the math here is the one place where a bug is
 * both silent and poisons every number downstream of it.
 */

/**
 * An indicator value that may not exist yet.
 *
 * Indicators have a warm-up window — a 200-day moving average has no value until the
 * 200th bar. Those positions are `null`, never `0` and never `NaN`, because `0` would
 * plot as a real data point and `NaN` propagates silently through arithmetic.
 */
export type MaybeNum = number | null

/** Read-only numeric input. Indicator functions must never mutate their input. */
export type Series = readonly number[]

export type Interval = '1d' | '1wk' | '1mo'

/**
 * A single price bar.
 *
 * The `c` / `ac` split is load-bearing and the most important convention in this codebase:
 *
 * - `c`  is the **price-return** close: split-adjusted, but *not* dividend-adjusted.
 *        Use it for candlestick rendering. Splits must be applied even for display, or a
 *        long chart shows a cliff on the split date that no shareholder ever experienced —
 *        which is why every charting platform shows split-adjusted history.
 * - `ac` is the **total-return** close: adjusted for both splits and dividends.
 *        Use it for every return, volatility, beta, drawdown and correlation calculation.
 *
 * Getting this wrong is the classic quant bug, and it fails in two different directions
 * depending on the provider:
 *
 * - If a provider returns genuinely unadjusted closes, a returns series built from `c`
 *   reports a catastrophic loss on every split that never happened.
 * - Even when splits are pre-adjusted upstream (Yahoo's chart endpoint does this — verified
 *   against NVDA's 10-for-1 split on 2024-06-10, where neither series shows a
 *   discontinuity), using `c` for returns still silently *understates* total return by
 *   discarding all dividend income. For a high-yield holding held for years that error
 *   compounds into a badly wrong performance figure.
 *
 * So `lib/quant/returns.ts` accepts only `ac`-derived series, and the provider contract
 * requires `ac` to be fully adjusted regardless of what the upstream source does natively.
 */
export interface Bar {
  /** Epoch milliseconds at the session close, UTC. */
  t: number
  /** Raw open. */
  o: number
  /** Raw high. */
  h: number
  /** Raw low. */
  l: number
  /** Raw close — for rendering. */
  c: number
  /** Adjusted close — for all returns math. */
  ac: number
  /** Volume in shares. */
  v: number
}

/** Trading periods per year, used to annualize periodic statistics. */
export const PERIODS_PER_YEAR: Record<Interval, number> = {
  '1d': 252,
  '1wk': 52,
  '1mo': 12,
}

/**
 * Extract the adjusted-close series from bars — the only sanctioned input to returns math.
 */
export function adjustedCloses(bars: readonly Bar[]): number[] {
  return bars.map((b) => b.ac)
}

/**
 * Extract raw closes. For rendering and for indicators that are conventionally quoted on
 * raw price (e.g. a moving average drawn on a candlestick chart, which must line up
 * visually with the candles beside it).
 */
export function rawCloses(bars: readonly Bar[]): number[] {
  return bars.map((b) => b.c)
}

/** True when the value is a usable, finite number. Guards against null/NaN/Infinity. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Drop leading `null`s and any non-finite values, returning the usable tail.
 * Used when feeding an indicator's output into a second computation.
 */
export function compact(v: readonly MaybeNum[]): number[] {
  const out: number[] = []
  for (const x of v) if (isNum(x)) out.push(x)
  return out
}

/**
 * Allocate a `MaybeNum[]` of the given length, pre-filled with `null`.
 *
 * Every indicator returns an array the same length as its input, left-padded with `null`
 * through the warm-up window. That alignment contract means chart series and price series
 * share indices, which makes off-by-one errors structurally impossible rather than merely
 * unlikely.
 */
export function padded(length: number): MaybeNum[] {
  return new Array<MaybeNum>(length).fill(null)
}
