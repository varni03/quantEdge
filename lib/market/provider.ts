/**
 * The market-data provider interface.
 *
 * This is the seam that decides whether replacing the data source later is a one-file
 * change or a rewrite. v1 runs on `yahoo-finance2`, which is free and needs no signup but
 * is an *unofficial* API — its own README states Yahoo provides no developer API and makes
 * no guarantee of availability or consistency. Treat it as a scaffold with an expiry date.
 *
 * Two rules keep the swap cheap, and both are enforced rather than trusted:
 *
 * 1. No feature code anywhere imports `yahoo-finance2`. Only `providers/yahoo.ts` does.
 * 2. An ESLint `no-restricted-imports` rule fails the build if rule 1 is violated, so it
 *    cannot quietly rot as the codebase grows.
 *
 * Feature code doesn't even call this interface directly — it calls `lib/market/cache.ts`,
 * which adds the database-backed bar cache and rate limiting on top.
 */

import type { Bar, Interval } from '@/lib/quant/types'
import type { MarketState } from '@/lib/market/calendar'

export type { Bar, Interval }

/** Asset classes we distinguish. v1 supports US equities and ETFs. */
export type AssetClass = 'EQUITY' | 'ETF' | 'CRYPTO' | 'INDEX' | 'MUTUALFUND' | 'OTHER'

/**
 * A current price quote.
 *
 * `quoteTime` is not decoration — it drives the as-of badge in the UI. A quote whose
 * timestamp is yesterday must never be rendered as a live price.
 */
export interface Quote {
  symbol: string
  price: number
  previousClose: number
  /** Absolute change vs previous close, in price units. */
  change: number
  /** Fractional change vs previous close (0.0247 = +2.47%), not a percentage. */
  changePercent: number
  open: number | null
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
  fiftyTwoWeekHigh: number | null
  fiftyTwoWeekLow: number | null
  currency: string
  exchange: string | null
  marketState: MarketState
  /** Epoch ms when the provider says this price was current. */
  quoteTime: number
  /** Which provider produced this, for debugging and for staleness attribution. */
  source: string
}

/** Descriptive and fundamental data about an instrument. */
export interface Profile {
  symbol: string
  name: string | null
  assetClass: AssetClass
  sector: string | null
  industry: string | null
  country: string | null
  currency: string
  exchange: string | null
  marketCap: bigint | null
  sharesOutstanding: bigint | null
  peRatio: number | null
  forwardPe: number | null
  /** Trailing dividend yield as a decimal (0.0154 = 1.54%). */
  dividendYield: number | null
  eps: number | null
  /**
   * The provider's own beta figure. Kept for comparison only — the app computes its own
   * beta from price history, against the user's chosen benchmark and window, so the two
   * will legitimately differ.
   */
  providerBeta: number | null
  longSummary: string | null
  website: string | null
}

export interface SearchHit {
  symbol: string
  name: string
  exchange: string | null
  assetClass: AssetClass
}

export interface NewsItem {
  id: string
  title: string
  publisher: string | null
  url: string
  /** Epoch ms. */
  publishedAt: number
  symbols: string[]
  summary: string | null
}

export interface Dividend {
  /** Epoch ms of the ex-dividend date. */
  exDate: number
  payDate: number | null
  /** Dividend amount per share. */
  amount: number
}

export interface Split {
  /** Epoch ms of the split date. */
  date: number
  numerator: number
  denominator: number
}

export interface EarningsEvent {
  symbol: string
  /** Epoch ms. */
  date: number
  /**
   * Providers frequently return an estimated window rather than a confirmed date. The UI
   * must say "expected" rather than stating a date as fact when this is true.
   */
  isEstimatedDate: boolean
  epsEstimate: number | null
  epsActual: number | null
}

/**
 * What a given provider can actually do.
 *
 * Declared rather than assumed so feature code can degrade gracefully instead of throwing
 * when a provider lacks, say, news. `maxSymbolsPerQuoteCall` exists because batching quote
 * requests is the single most important thing that keeps a 30-ticker dashboard inside a
 * free rate limit.
 */
export interface ProviderCapabilities {
  news: boolean
  fundamentals: boolean
  intraday: boolean
  earnings: boolean
  corporateActions: boolean
  adjustedClose: boolean
  maxSymbolsPerQuoteCall: number
}

export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'BAD_SYMBOL'
  | 'UNKNOWN'

/**
 * A normalized provider failure.
 *
 * Every provider must map its own error shapes onto these codes, so callers can implement
 * one retry/backoff policy instead of one per provider. `RATE_LIMITED` in particular must
 * be distinguishable from a genuine failure — backing off is the correct response, whereas
 * retrying immediately makes it worse.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly retryAfterMs?: number
  readonly symbol?: string

  constructor(
    message: string,
    code: ProviderErrorCode,
    opts: { retryAfterMs?: number; symbol?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'ProviderError'
    this.code = code
    this.retryAfterMs = opts.retryAfterMs
    this.symbol = opts.symbol
  }
}

export interface GetBarsOptions {
  from: Date
  to?: Date
  interval?: Interval
}

/**
 * The provider contract.
 *
 * Implementations must:
 * - return bars in ascending time order, with no duplicate timestamps;
 * - populate `Bar.ac` with a split- and dividend-adjusted close (if the upstream source
 *   only offers raw closes, the provider is responsible for applying adjustments, and must
 *   report `adjustedClose: false` so callers know returns math is unreliable);
 * - throw {@link ProviderError} rather than provider-specific error types;
 * - never return `NaN` — omit or null the field instead.
 */
export interface MarketDataProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities

  /** Batched by design: callers must not loop this one symbol at a time. */
  getQuotes(symbols: string[]): Promise<Quote[]>

  getBars(symbol: string, opts: GetBarsOptions): Promise<Bar[]>

  getProfile(symbol: string): Promise<Profile | null>

  search(query: string, limit?: number): Promise<SearchHit[]>

  getNews(symbols: string[], limit?: number): Promise<NewsItem[]>

  getCorporateActions(
    symbol: string,
    from: Date,
  ): Promise<{ dividends: Dividend[]; splits: Split[] }>

  getEarningsCalendar(symbols: string[]): Promise<EarningsEvent[]>
}

// ── shared validation ───────────────────────────────────────────────────────────

/**
 * Reject a bar that cannot be true.
 *
 * A single bad bar corrupts every metric computed downstream of it, and because the bar
 * cache is write-once, a bad bar persists until someone notices a wrong number weeks later.
 * Validating at the boundary and dropping the offender is far cheaper than debugging that.
 */
export function isValidBar(bar: Bar, now = Date.now()): boolean {
  const nums = [bar.t, bar.o, bar.h, bar.l, bar.c, bar.ac, bar.v]
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false

  if (bar.o <= 0 || bar.h <= 0 || bar.l <= 0 || bar.c <= 0 || bar.ac <= 0) return false
  if (bar.v < 0) return false
  if (bar.h < bar.l) return false
  if (bar.h < bar.o || bar.h < bar.c) return false
  if (bar.l > bar.o || bar.l > bar.c) return false

  // A bar dated in the future means a timezone or parsing error upstream. One day of
  // tolerance covers timezone skew around the session close without letting real
  // nonsense through.
  if (bar.t > now + 86_400_000) return false

  return true
}

/**
 * Filter a bar series to valid, unique, ascending bars.
 * Returns the clean series plus how many were dropped, so callers can log rather than
 * silently lose data.
 */
export function sanitizeBars(
  bars: readonly Bar[],
  now = Date.now(),
): { bars: Bar[]; dropped: number } {
  const seen = new Set<number>()
  const out: Bar[] = []
  let dropped = 0

  for (const bar of bars) {
    if (!isValidBar(bar, now) || seen.has(bar.t)) {
      dropped++
      continue
    }
    seen.add(bar.t)
    out.push(bar)
  }

  out.sort((a, b) => a.t - b.t)
  return { bars: out, dropped }
}
