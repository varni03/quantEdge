/**
 * Technical indicators.
 *
 * Pure functions over numeric arrays. No React, no database, no network.
 *
 * **The alignment contract.** Every function here returns an array *the same length as its
 * input*, left-padded with `null` through the warm-up window. A 50-period moving average
 * over 200 closes returns 200 entries, the first 49 of which are `null`.
 *
 * This is the single most important API decision in the quant layer. Because output indices
 * match input indices, a chart can plot `closes[i]` and `sma50[i]` against the same x-axis
 * with no offset arithmetic anywhere — which makes the classic off-by-one indicator bug
 * structurally impossible instead of merely unlikely.
 *
 * `null` rather than `0` for the warm-up matters too: `0` renders as a real data point and
 * drags chart axes to the origin, and it silently corrupts any average taken over the
 * series.
 */

import { type Bar, type MaybeNum, type Series, isNum, padded } from '@/lib/quant/types'

// ── moving averages ─────────────────────────────────────────────────────────────

/**
 * Simple moving average.
 *
 * Computed with a running sum rather than re-summing each window, so this is O(n) rather
 * than O(n·period) — which matters when a dashboard computes a 200-day average across
 * thirty positions on every render.
 */
export function sma(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'sma')
  const out = padded(values.length)
  if (period > values.length) return out

  let sum = 0
  let count = 0

  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!isNum(v)) {
      // A gap resets the window: averaging across a hole would silently blend
      // pre- and post-gap prices as if they were contiguous.
      sum = 0
      count = 0
      continue
    }

    sum += v
    count++

    if (count > period) {
      const dropped = values[i - period]
      if (isNum(dropped)) sum -= dropped
      count = period
    }

    if (count === period) out[i] = sum / period
  }

  return out
}

/**
 * Exponential moving average.
 *
 * Seeded with the SMA of the first `period` values — the conventional choice, and the one
 * that makes the series comparable with other tools. Smoothing factor is `2/(period+1)`.
 */
export function ema(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'ema')
  const out = padded(values.length)
  if (period > values.length) return out

  const k = 2 / (period + 1)
  let prev: number | null = null

  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      // Still seeking a seed: use the SMA once a full clean window exists.
      if (i + 1 >= period) {
        let sum = 0
        let ok = true
        for (let j = i - period + 1; j <= i; j++) {
          const v = values[j]
          if (!isNum(v)) {
            ok = false
            break
          }
          sum += v
        }
        if (ok) {
          prev = sum / period
          out[i] = prev
        }
      }
      continue
    }

    const v = values[i]
    if (!isNum(v)) continue
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }

  return out
}

/**
 * Wilder's smoothing (also called RMA or SMMA), the basis of RSI, ATR and ADX.
 *
 * Distinct from {@link ema}: the smoothing factor is `1/period`, not `2/(period+1)`. Using
 * an EMA here instead is a common and subtle error — it produces RSI values that look
 * plausible but disagree with every charting platform, which is much worse than being
 * obviously wrong.
 */
export function wilderSmooth(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'wilderSmooth')
  const out = padded(values.length)
  if (period > values.length) return out

  let prev: number | null = null

  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i + 1 >= period) {
        let sum = 0
        let ok = true
        for (let j = i - period + 1; j <= i; j++) {
          const v = values[j]
          if (!isNum(v)) {
            ok = false
            break
          }
          sum += v
        }
        if (ok) {
          prev = sum / period
          out[i] = prev
        }
      }
      continue
    }

    const v = values[i]
    if (!isNum(v)) continue
    prev = (prev * (period - 1) + v) / period
    out[i] = prev
  }

  return out
}

// ── momentum / oscillators ──────────────────────────────────────────────────────

/**
 * Relative Strength Index, using Wilder's original smoothing.
 *
 * Returns 0–100. Conventional reading: above 70 is "overbought", below 30 "oversold" —
 * though both are descriptive labels for a mechanical threshold, not predictions.
 *
 * Edge cases handled deliberately:
 * - A strictly rising series has no average loss, giving RSI exactly 100 (not `NaN` from a
 *   division by zero, which is what a naive implementation produces).
 * - A flat series has neither gains nor losses; RSI is defined as 50 by convention.
 */
export function rsi(closes: Series, period = 14): MaybeNum[] {
  assertPeriod(period, 'rsi')
  const n = closes.length
  const out = padded(n)
  if (n < period + 1) return out

  const gains: number[] = new Array(n).fill(0)
  const losses: number[] = new Array(n).fill(0)

  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1]
    gains[i] = diff > 0 ? diff : 0
    losses[i] = diff < 0 ? -diff : 0
  }

  // Seed with a simple average over the first `period` changes (indices 1..period).
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i]
    avgLoss += losses[i]
  }
  avgGain /= period
  avgLoss /= period
  out[period] = rsiFrom(avgGain, avgLoss)

  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    out[i] = rsiFrom(avgGain, avgLoss)
  }

  return out
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/**
 * MACD — the difference between two EMAs, its own EMA (the signal line), and the gap
 * between them (the histogram).
 *
 * The signal line is an EMA of the MACD line, which only exists after the slow EMA warms
 * up, so the signal's own warm-up is offset accordingly. Computing it over the padded array
 * directly would misalign it.
 */
export function macd(
  closes: Series,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: MaybeNum[]; signal: MaybeNum[]; histogram: MaybeNum[] } {
  assertPeriod(fastPeriod, 'macd.fast')
  assertPeriod(slowPeriod, 'macd.slow')
  assertPeriod(signalPeriod, 'macd.signal')
  if (fastPeriod >= slowPeriod) {
    throw new Error('macd: fastPeriod must be less than slowPeriod')
  }

  const n = closes.length
  const fast = ema(closes, fastPeriod)
  const slow = ema(closes, slowPeriod)

  const macdLine = padded(n)
  for (let i = 0; i < n; i++) {
    const f = fast[i]
    const s = slow[i]
    if (isNum(f) && isNum(s)) macdLine[i] = f - s
  }

  // Run the signal EMA over the dense tail, then map it back to absolute indices.
  const firstMacd = macdLine.findIndex(isNum)
  const signal = padded(n)
  const histogram = padded(n)

  if (firstMacd !== -1) {
    const dense = macdLine.slice(firstMacd).filter(isNum)
    const denseSignal = ema(dense, signalPeriod)
    for (let j = 0; j < denseSignal.length; j++) {
      const v = denseSignal[j]
      if (isNum(v)) {
        const i = firstMacd + j
        signal[i] = v
        const m = macdLine[i]
        if (isNum(m)) histogram[i] = m - v
      }
    }
  }

  return { macd: macdLine, signal, histogram }
}

/**
 * Stochastic oscillator. `%K` is where the close sits within the recent high–low range;
 * `%D` is a smoothing of `%K`.
 */
export function stochastic(
  bars: readonly Bar[],
  kPeriod = 14,
  dPeriod = 3,
): { k: MaybeNum[]; d: MaybeNum[] } {
  assertPeriod(kPeriod, 'stochastic.k')
  assertPeriod(dPeriod, 'stochastic.d')

  const n = bars.length
  const k = padded(n)

  for (let i = kPeriod - 1; i < n; i++) {
    let high = -Infinity
    let low = Infinity
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].h > high) high = bars[j].h
      if (bars[j].l < low) low = bars[j].l
    }
    const range = high - low
    // A zero range means the price never moved in the window; %K is undefined, and 50
    // (the midpoint) is the conventional reading rather than a division by zero.
    k[i] = range === 0 ? 50 : ((bars[i].c - low) / range) * 100
  }

  const firstK = k.findIndex(isNum)
  const d = padded(n)
  if (firstK !== -1) {
    const dense = k.slice(firstK).filter(isNum)
    const denseD = sma(dense, dPeriod)
    for (let j = 0; j < denseD.length; j++) {
      const v = denseD[j]
      if (isNum(v)) d[firstK + j] = v
    }
  }

  return { k, d }
}

// ── volatility / bands ──────────────────────────────────────────────────────────

/**
 * Bollinger Bands: an SMA with bands at ±`mult` standard deviations.
 *
 * Also returns two derived readings that are more useful than the raw bands:
 * - `bandwidth` — band width relative to the middle, i.e. how volatile the recent past has
 *   been. A historically low bandwidth is the "squeeze" that precedes range expansion.
 * - `percentB` — where price sits within the bands (0 = lower, 1 = upper), which is
 *   comparable across instruments in a way the raw bands are not.
 */
export function bollinger(
  closes: Series,
  period = 20,
  mult = 2,
): {
  upper: MaybeNum[]
  middle: MaybeNum[]
  lower: MaybeNum[]
  bandwidth: MaybeNum[]
  percentB: MaybeNum[]
} {
  assertPeriod(period, 'bollinger')
  const n = closes.length
  const middle = sma(closes, period)
  const sd = rollingStdev(closes, period, false)

  const upper = padded(n)
  const lower = padded(n)
  const bandwidth = padded(n)
  const percentB = padded(n)

  for (let i = 0; i < n; i++) {
    const m = middle[i]
    const s = sd[i]
    if (!isNum(m) || !isNum(s)) continue

    const u = m + mult * s
    const l = m - mult * s
    upper[i] = u
    lower[i] = l
    bandwidth[i] = m === 0 ? null : (u - l) / m

    const range = u - l
    percentB[i] = range === 0 ? 0.5 : (closes[i] - l) / range
  }

  return { upper, middle, lower, bandwidth, percentB }
}

/**
 * True Range — the greatest of today's high–low, and the gaps from yesterday's close.
 * Including the prior close is what makes this capture overnight gaps, which a plain
 * high-minus-low misses entirely.
 */
export function trueRange(bars: readonly Bar[]): MaybeNum[] {
  const out = padded(bars.length)
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i]
    const prevClose = bars[i - 1].c
    out[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose))
  }
  return out
}

/** Average True Range — Wilder-smoothed true range. A volatility measure in price units. */
export function atr(bars: readonly Bar[], period = 14): MaybeNum[] {
  assertPeriod(period, 'atr')
  const n = bars.length
  const tr = trueRange(bars)
  const out = padded(n)

  // True range starts at index 1, so the Wilder average is offset by one.
  const dense = tr.slice(1).filter(isNum)
  if (dense.length < period) return out

  const smoothed = wilderSmooth(dense, period)
  for (let j = 0; j < smoothed.length; j++) {
    const v = smoothed[j]
    if (isNum(v)) out[j + 1] = v
  }
  return out
}

/**
 * Average Directional Index, with the directional indicators it's built from.
 *
 * ADX measures trend *strength* without direction — a high ADX means a strong trend, up or
 * down. `plusDI` above `minusDI` indicates the direction.
 */
export function adx(
  bars: readonly Bar[],
  period = 14,
): { adx: MaybeNum[]; plusDI: MaybeNum[]; minusDI: MaybeNum[] } {
  assertPeriod(period, 'adx')
  const n = bars.length
  const outAdx = padded(n)
  const outPlus = padded(n)
  const outMinus = padded(n)
  if (n < period * 2) return { adx: outAdx, plusDI: outPlus, minusDI: outMinus }

  const plusDM: number[] = []
  const minusDM: number[] = []
  const tr: number[] = []

  for (let i = 1; i < n; i++) {
    const upMove = bars[i].h - bars[i - 1].h
    const downMove = bars[i - 1].l - bars[i].l

    // Only the larger move counts, and only when positive — the two are mutually exclusive.
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)

    const prevClose = bars[i - 1].c
    tr.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - prevClose),
        Math.abs(bars[i].l - prevClose),
      ),
    )
  }

  const smTr = wilderSmooth(tr, period)
  const smPlus = wilderSmooth(plusDM, period)
  const smMinus = wilderSmooth(minusDM, period)

  const dx: MaybeNum[] = padded(tr.length)
  for (let j = 0; j < tr.length; j++) {
    const t = smTr[j]
    const p = smPlus[j]
    const m = smMinus[j]
    if (!isNum(t) || !isNum(p) || !isNum(m) || t === 0) continue

    const pdi = (p / t) * 100
    const mdi = (m / t) * 100
    outPlus[j + 1] = pdi
    outMinus[j + 1] = mdi

    const sum = pdi + mdi
    dx[j] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100
  }

  const firstDx = dx.findIndex(isNum)
  if (firstDx !== -1) {
    const denseDx = dx.slice(firstDx).filter(isNum)
    const smoothedDx = wilderSmooth(denseDx, period)
    for (let j = 0; j < smoothedDx.length; j++) {
      const v = smoothedDx[j]
      if (isNum(v)) outAdx[firstDx + j + 1] = v
    }
  }

  return { adx: outAdx, plusDI: outPlus, minusDI: outMinus }
}

// ── volume ──────────────────────────────────────────────────────────────────────

/**
 * On-Balance Volume — a running total that adds volume on up-closes and subtracts it on
 * down-closes. Only the *shape* is meaningful; the absolute level depends on where the
 * series starts, so it always begins at 0 here.
 */
export function obv(bars: readonly Bar[]): number[] {
  const out = new Array<number>(bars.length).fill(0)
  let running = 0
  for (let i = 1; i < bars.length; i++) {
    const diff = bars[i].c - bars[i - 1].c
    if (diff > 0) running += bars[i].v
    else if (diff < 0) running -= bars[i].v
    out[i] = running
  }
  return out
}

/**
 * Volume-Weighted Average Price over a rolling window.
 *
 * Note this is the rolling form, not the intraday session VWAP traders usually mean —
 * daily bars have no intraday detail to anchor a session VWAP to.
 */
export function vwap(bars: readonly Bar[], period = 20): MaybeNum[] {
  assertPeriod(period, 'vwap')
  const out = padded(bars.length)

  for (let i = period - 1; i < bars.length; i++) {
    let pv = 0
    let vol = 0
    for (let j = i - period + 1; j <= i; j++) {
      const typical = (bars[j].h + bars[j].l + bars[j].c) / 3
      pv += typical * bars[j].v
      vol += bars[j].v
    }
    // Zero volume across the whole window (a halted or untraded instrument) leaves VWAP
    // genuinely undefined.
    out[i] = vol === 0 ? null : pv / vol
  }

  return out
}

// ── rolling statistics ──────────────────────────────────────────────────────────

export function rollingHigh(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'rollingHigh')
  const out = padded(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity
    for (let j = i - period + 1; j <= i; j++) if (values[j] > max) max = values[j]
    out[i] = Number.isFinite(max) ? max : null
  }
  return out
}

export function rollingLow(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'rollingLow')
  const out = padded(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity
    for (let j = i - period + 1; j <= i; j++) if (values[j] < min) min = values[j]
    out[i] = Number.isFinite(min) ? min : null
  }
  return out
}

/** Rolling mean. Alias of {@link sma}, named for use in statistical rather than charting contexts. */
export function rollingMean(values: Series, period: number): MaybeNum[] {
  return sma(values, period)
}

/**
 * Rolling standard deviation.
 *
 * @param sample `true` for the sample standard deviation (divide by n−1), `false` for the
 * population form (divide by n). Bollinger Bands conventionally use the population form,
 * which is why it isn't the default everywhere — the distinction is small but it changes
 * band values enough to disagree with other charting tools.
 */
export function rollingStdev(values: Series, period: number, sample = true): MaybeNum[] {
  assertPeriod(period, 'rollingStdev')
  const out = padded(values.length)
  const divisor = sample ? period - 1 : period
  if (divisor <= 0) return out

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    const mean = sum / period

    let sq = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean
      sq += d * d
    }
    out[i] = Math.sqrt(sq / divisor)
  }

  return out
}

/**
 * Rolling z-score: how many standard deviations the current value sits from its own recent
 * mean. Useful for "unusual volume" detection, where the raw number means nothing without
 * knowing what's normal for that instrument.
 */
export function zScore(values: Series, period: number): MaybeNum[] {
  assertPeriod(period, 'zScore')
  const n = values.length
  const mean = sma(values, period)
  const sd = rollingStdev(values, period, true)
  const out = padded(n)

  for (let i = 0; i < n; i++) {
    const m = mean[i]
    const s = sd[i]
    if (!isNum(m) || !isNum(s) || s === 0) continue
    out[i] = (values[i] - m) / s
  }

  return out
}

// ── rate of change ──────────────────────────────────────────────────────────────

/** Absolute change over `lookback` periods, in the input's own units. */
export function momentum(values: Series, lookback: number): MaybeNum[] {
  assertPeriod(lookback, 'momentum')
  const out = padded(values.length)
  for (let i = lookback; i < values.length; i++) out[i] = values[i] - values[i - lookback]
  return out
}

/**
 * Fractional change over `lookback` periods (0.12 = +12%).
 *
 * Returns a fraction, not a percentage, matching the app-wide convention that percentages
 * are stored as decimals and formatted only at the edge.
 */
export function rateOfChange(values: Series, lookback: number): MaybeNum[] {
  assertPeriod(lookback, 'rateOfChange')
  const out = padded(values.length)
  for (let i = lookback; i < values.length; i++) {
    const base = values[i - lookback]
    if (base === 0) continue
    out[i] = (values[i] - base) / base
  }
  return out
}

// ── guard ───────────────────────────────────────────────────────────────────────

function assertPeriod(period: number, fn: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${fn}: period must be a positive integer, got ${period}`)
  }
}
