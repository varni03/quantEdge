/**
 * Yahoo Finance provider.
 *
 * ⚠️ THIS IS THE ONLY FILE IN THE CODEBASE PERMITTED TO IMPORT `yahoo-finance2`.
 * An ESLint `no-restricted-imports` rule enforces that. The reason is not tidiness: Yahoo
 * has no official public API, and the library's own documentation says not to assume data
 * availability, freshness, or shape is guaranteed. When it eventually breaks or has to be
 * replaced with a paid provider, that must be a change to this one file rather than an
 * archaeology expedition across the whole app.
 *
 * Everything here maps Yahoo's shapes onto the neutral types in `../provider.ts`. Nothing
 * Yahoo-specific escapes this module.
 */

import YahooFinance from 'yahoo-finance2'

import type { Bar, Interval } from '@/lib/quant/types'
import type { MarketState } from '@/lib/market/calendar'
import {
  type AssetClass,
  type Dividend,
  type EarningsEvent,
  type GetBarsOptions,
  type MarketDataProvider,
  type NewsItem,
  type Profile,
  type ProviderCapabilities,
  type Quote,
  type SearchHit,
  type Split,
  ProviderError,
  sanitizeBars,
} from '@/lib/market/provider'
import { chunk, providerLimiter, withRetry } from '@/lib/market/limiter'
import { normalizeCurrencyAmount, normalizeSymbol } from '@/lib/market/symbols'

/**
 * The library ships its own request queue. We configure it conservatively *and* wrap calls
 * in our own limiter — the library's queue bounds concurrency within one client instance,
 * while ours also enforces a minimum gap between request starts and coalesces duplicate
 * in-flight requests across the process.
 */
const client = new YahooFinance({
  queue: { concurrency: 2, interval: 250 },
  // Suppress the library's "please star the repo" notice and survey prompts in logs.
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
})

/** Yahoo's `marketState` has finer gradations than we model; collapse them. */
function mapMarketState(state: string | undefined): MarketState {
  switch (state) {
    case 'REGULAR':
      return 'REGULAR'
    case 'PRE':
    case 'PREPRE':
      return 'PRE'
    case 'POST':
    case 'POSTPOST':
      return 'POST'
    default:
      return 'CLOSED'
  }
}

function mapAssetClass(quoteType: string | undefined): AssetClass {
  switch (quoteType) {
    case 'EQUITY':
      return 'EQUITY'
    case 'ETF':
      return 'ETF'
    case 'INDEX':
      return 'INDEX'
    case 'MUTUALFUND':
      return 'MUTUALFUND'
    case 'CRYPTOCURRENCY':
      return 'CRYPTO'
    default:
      return 'OTHER'
  }
}

/** Yahoo's daily intervals we support. Intraday is deliberately out of scope for v1. */
function mapInterval(interval: Interval): '1d' | '1wk' | '1mo' {
  return interval
}

/**
 * Translate an arbitrary thrown value into a {@link ProviderError}.
 *
 * The important distinction is retryable (rate limit, transient network) versus terminal
 * (bad symbol). Retrying a nonexistent ticker just burns rate-limit budget, and treating a
 * rate limit as terminal makes the dashboard fail for no reason.
 */
function toProviderError(err: unknown, symbol?: string): ProviderError {
  if (err instanceof ProviderError) return err

  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  // Yahoo signals throttling with HTTP 429, and occasionally with an explicit phrase.
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit')) {
    return new ProviderError(`Yahoo rate limited: ${message}`, 'RATE_LIMITED', {
      symbol,
      cause: err,
      retryAfterMs: 5_000,
    })
  }

  if (
    lower.includes('not found') ||
    lower.includes('no data found') ||
    lower.includes('404') ||
    lower.includes('symbol may be delisted')
  ) {
    return new ProviderError(`Symbol not found: ${symbol ?? 'unknown'}`, 'NOT_FOUND', {
      symbol,
      cause: err,
    })
  }

  if (
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up')
  ) {
    return new ProviderError(`Yahoo unavailable: ${message}`, 'UNAVAILABLE', {
      symbol,
      cause: err,
      retryAfterMs: 2_000,
    })
  }

  // Schema validation failures mean Yahoo changed shape underneath us — exactly the
  // scenario the provider seam exists for. Surface it distinctly so it's diagnosable.
  if (lower.includes('validation') || lower.includes('schema')) {
    return new ProviderError(
      `Yahoo response failed validation (upstream shape may have changed): ${message}`,
      'UNKNOWN',
      { symbol, cause: err },
    )
  }

  return new ProviderError(message, 'UNKNOWN', { symbol, cause: err })
}

/** Retry policy: back off on throttling and transient failures, give up on bad symbols. */
function run<T>(task: () => Promise<T>, symbol?: string): Promise<T> {
  return providerLimiter.schedule(() =>
    withRetry(
      async () => {
        try {
          return await task()
        } catch (err) {
          throw toProviderError(err, symbol)
        }
      },
      {
        attempts: 3,
        shouldRetry: (err) =>
          err instanceof ProviderError &&
          (err.code === 'RATE_LIMITED' || err.code === 'UNAVAILABLE'),
        retryAfterMs: (err) => (err instanceof ProviderError ? err.retryAfterMs : undefined),
      },
    ),
  )
}

const capabilities: ProviderCapabilities = {
  news: true,
  fundamentals: true,
  intraday: false, // available upstream, deliberately unused in v1
  earnings: true,
  corporateActions: true,
  adjustedClose: true,
  // Yahoo tolerates large batches; 40 keeps URLs comfortably short and errors granular.
  maxSymbolsPerQuoteCall: 40,
}

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo'
  readonly capabilities = capabilities

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const wanted = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean)
    if (wanted.length === 0) return []

    const batches = chunk(wanted, capabilities.maxSymbolsPerQuoteCall)
    const results: Quote[] = []

    for (const batch of batches) {
      const raw = await run(() => client.quote(batch))
      // `quote()` returns an array for an array input, but a single object for a single
      // string input; normalize defensively since a one-symbol batch is common.
      const list = Array.isArray(raw) ? raw : raw ? [raw] : []

      for (const q of list) {
        const quote = this.mapQuote(q)
        if (quote) results.push(quote)
      }
    }

    return results
  }

  private mapQuote(q: Record<string, unknown>): Quote | null {
    const symbol = typeof q.symbol === 'string' ? normalizeSymbol(q.symbol) : null
    if (!symbol) return null

    const rawPrice = num(q.regularMarketPrice)
    if (rawPrice === null) return null // a quote with no price is not a quote

    const rawCurrency = typeof q.currency === 'string' ? q.currency : 'USD'
    const { price, currency } = normalizeCurrencyAmount(rawPrice, rawCurrency)
    // The same minor-unit scaling must apply to every price-shaped field, or the day range
    // and 52-week range would be 100× off relative to the price on London listings.
    const scale = price / rawPrice

    const previousClose = num(q.regularMarketPreviousClose)
    const change = num(q.regularMarketChange)
    const changePercentRaw = num(q.regularMarketChangePercent)

    return {
      symbol,
      price,
      previousClose: previousClose !== null ? previousClose * scale : price,
      change: change !== null ? change * scale : 0,
      // Yahoo reports this as a percentage (2.47); the app stores fractions (0.0247).
      changePercent: changePercentRaw !== null ? changePercentRaw / 100 : 0,
      open: scaleOrNull(num(q.regularMarketOpen), scale),
      dayHigh: scaleOrNull(num(q.regularMarketDayHigh), scale),
      dayLow: scaleOrNull(num(q.regularMarketDayLow), scale),
      volume: num(q.regularMarketVolume),
      fiftyTwoWeekHigh: scaleOrNull(num(q.fiftyTwoWeekHigh), scale),
      fiftyTwoWeekLow: scaleOrNull(num(q.fiftyTwoWeekLow), scale),
      currency,
      exchange: str(q.fullExchangeName) ?? str(q.exchange),
      marketState: mapMarketState(str(q.marketState) ?? undefined),
      quoteTime: toEpochMs(q.regularMarketTime) ?? Date.now(),
      source: this.name,
    }
  }

  async getBars(symbol: string, opts: GetBarsOptions): Promise<Bar[]> {
    const sym = normalizeSymbol(symbol)
    const interval = mapInterval(opts.interval ?? '1d')

    // `period2` must be omitted entirely when open-ended — the library's option validator
    // rejects the key being present with an `undefined` value.
    const query = {
      period1: opts.from,
      ...(opts.to ? { period2: opts.to } : {}),
      interval,
      events: 'div|split',
      return: 'array' as const,
    }

    const result = await run(() => client.chart(sym, query), sym)

    const rawCurrency = typeof result.meta?.currency === 'string' ? result.meta.currency : 'USD'
    const scale = currencyScale(rawCurrency)

    const mapped: Bar[] = []
    for (const q of result.quotes ?? []) {
      const close = num(q.close)
      const open = num(q.open)
      const high = num(q.high)
      const low = num(q.low)
      const t = q.date instanceof Date ? q.date.getTime() : toEpochMs(q.date)

      // A bar missing any OHLC leg is unusable. Yahoo emits these for halted sessions.
      if (t === null || close === null || open === null || high === null || low === null) continue

      // `adjclose` is optional upstream. Falling back to the raw close is correct for a
      // symbol with no splits or dividends, and for one that has them the returns math
      // would be wrong either way — so this is the honest default, and `capabilities`
      // still advertises adjusted-close support because Yahoo does provide it when it
      // exists.
      const adjClose = num(q.adjclose) ?? close

      mapped.push({
        t,
        o: open * scale,
        h: high * scale,
        l: low * scale,
        c: close * scale,
        ac: adjClose * scale,
        v: num(q.volume) ?? 0,
      })
    }

    const { bars, dropped } = sanitizeBars(mapped)
    if (dropped > 0 && process.env.NODE_ENV !== 'production') {
      console.warn(`[yahoo] ${sym}: dropped ${dropped} invalid bar(s)`)
    }
    return bars
  }

  async getProfile(symbol: string): Promise<Profile | null> {
    const sym = normalizeSymbol(symbol)

    const summary = await run(
      () =>
        client.quoteSummary(sym, {
          modules: ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics'],
        }),
      sym,
    ).catch((err: unknown) => {
      if (err instanceof ProviderError && err.code === 'NOT_FOUND') return null
      throw err
    })

    if (!summary) return null

    const assetProfile = obj(summary.assetProfile)
    const price = obj(summary.price)
    const detail = obj(summary.summaryDetail)
    const stats = obj(summary.defaultKeyStatistics)

    const rawCurrency = str(price?.currency) ?? 'USD'
    const currency = normalizeCurrencyAmount(1, rawCurrency).currency

    return {
      symbol: sym,
      name: str(price?.longName) ?? str(price?.shortName),
      assetClass: mapAssetClass(str(price?.quoteType) ?? undefined),
      sector: str(assetProfile?.sector),
      industry: str(assetProfile?.industry),
      country: str(assetProfile?.country),
      currency,
      exchange: str(price?.exchangeName),
      marketCap: toBigInt(price?.marketCap ?? detail?.marketCap),
      sharesOutstanding: toBigInt(stats?.sharesOutstanding),
      peRatio: num(detail?.trailingPE),
      forwardPe: num(detail?.forwardPE ?? stats?.forwardPE),
      // Yahoo gives this as a fraction already (0.0154), matching our convention.
      dividendYield: num(detail?.dividendYield),
      eps: num(stats?.trailingEps),
      providerBeta: num(detail?.beta ?? stats?.beta),
      longSummary: str(assetProfile?.longBusinessSummary),
      website: str(assetProfile?.website),
    }
  }

  async search(query: string, limit = 10): Promise<SearchHit[]> {
    const q = query.trim()
    if (q.length === 0) return []

    const result = await run(() => client.search(q, { quotesCount: limit, newsCount: 0 }))

    const hits: SearchHit[] = []
    for (const item of result.quotes ?? []) {
      const rec = item as Record<string, unknown>
      const symbol = str(rec.symbol)
      if (!symbol) continue

      const assetClass = mapAssetClass(str(rec.quoteType) ?? undefined)
      // Options and futures are noise in a portfolio tracker's ticker picker.
      if (assetClass === 'OTHER') continue

      hits.push({
        symbol: normalizeSymbol(symbol),
        name: str(rec.longname) ?? str(rec.shortname) ?? symbol,
        exchange: str(rec.exchDisp) ?? str(rec.exchange),
        assetClass,
      })
    }

    return hits.slice(0, limit)
  }

  async getNews(symbols: string[], limit = 10): Promise<NewsItem[]> {
    const wanted = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean)
    if (wanted.length === 0) return []

    // Yahoo attaches news to a search query rather than offering a batch news endpoint, so
    // this is one request per symbol. Callers must therefore keep the symbol list short;
    // the cache layer enforces that.
    const perSymbol = Math.max(2, Math.ceil(limit / wanted.length))
    const byId = new Map<string, NewsItem>()

    for (const sym of wanted) {
      try {
        const result = await run(
          () => client.search(sym, { quotesCount: 0, newsCount: perSymbol }),
          sym,
        )
        for (const n of result.news ?? []) {
          const id = str(n.uuid)
          const title = str(n.title)
          const url = str(n.link)
          if (!id || !title || !url) continue

          const existing = byId.get(id)
          if (existing) {
            // The same story often surfaces for several tickers; merge the symbol list
            // rather than emitting duplicates.
            if (!existing.symbols.includes(sym)) existing.symbols.push(sym)
            continue
          }

          byId.set(id, {
            id,
            title,
            publisher: str(n.publisher),
            url,
            publishedAt: toEpochMs(n.providerPublishTime) ?? Date.now(),
            symbols: [sym, ...(Array.isArray(n.relatedTickers) ? n.relatedTickers.map(String) : [])]
              .map(normalizeSymbol)
              .filter((s, i, arr) => s && arr.indexOf(s) === i),
            summary: null,
          })
        }
      } catch (err) {
        // News is decorative. A failure here must never take down a portfolio page.
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[yahoo] news fetch failed for ${sym}:`, err)
        }
      }
    }

    return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit)
  }

  async getCorporateActions(
    symbol: string,
    from: Date,
  ): Promise<{ dividends: Dividend[]; splits: Split[] }> {
    const sym = normalizeSymbol(symbol)

    const result = await run(
      () =>
        client.chart(sym, {
          period1: from,
          interval: '1d',
          events: 'div|split',
          return: 'array',
        }),
      sym,
    )

    const rawCurrency = typeof result.meta?.currency === 'string' ? result.meta.currency : 'USD'
    const scale = currencyScale(rawCurrency)

    const dividends: Dividend[] = []
    for (const d of result.events?.dividends ?? []) {
      const date = d.date instanceof Date ? d.date.getTime() : toEpochMs(d.date)
      const amount = num(d.amount)
      if (date === null || amount === null) continue
      dividends.push({ exDate: date, payDate: null, amount: amount * scale })
    }

    const splits: Split[] = []
    for (const s of result.events?.splits ?? []) {
      const date = s.date instanceof Date ? s.date.getTime() : toEpochMs(s.date)
      const numerator = num(s.numerator)
      const denominator = num(s.denominator)
      if (date === null || !numerator || !denominator) continue
      splits.push({ date, numerator, denominator })
    }

    dividends.sort((a, b) => a.exDate - b.exDate)
    splits.sort((a, b) => a.date - b.date)
    return { dividends, splits }
  }

  async getEarningsCalendar(symbols: string[]): Promise<EarningsEvent[]> {
    const wanted = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean)
    const out: EarningsEvent[] = []

    for (const sym of wanted) {
      try {
        const summary = await run(
          () => client.quoteSummary(sym, { modules: ['calendarEvents', 'earnings'] }),
          sym,
        )

        const calendar = obj(obj(summary.calendarEvents)?.earnings)
        const dates = calendar?.earningsDate

        if (Array.isArray(dates) && dates.length > 0) {
          const first = toEpochMs(dates[0])
          if (first !== null) {
            out.push({
              symbol: sym,
              date: first,
              // Yahoo returns a two-element range when the date is not yet confirmed.
              isEstimatedDate: dates.length > 1,
              epsEstimate: num(calendar?.earningsAverage),
              epsActual: null,
            })
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[yahoo] earnings fetch failed for ${sym}:`, err)
        }
      }
    }

    return out
  }
}

// ── coercion helpers ────────────────────────────────────────────────────────────
//
// Yahoo's payloads are loosely typed and inconsistent: a field may be a number, a
// `{ raw, fmt }` wrapper, a string, or absent. These helpers collapse all of that to a
// definite value or `null` — never `NaN`, never `undefined`, because a `NaN` leaking into
// the quant engine silently poisons every number computed from it.

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (v && typeof v === 'object' && 'raw' in v) {
    return num((v as { raw: unknown }).raw)
  }
  return null
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null
  return null
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function toEpochMs(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime()
    return Number.isFinite(t) ? t : null
  }
  const n = num(v)
  if (n === null) return null
  // Yahoo sometimes returns seconds rather than milliseconds. Anything below this
  // threshold cannot plausibly be milliseconds (it would be 1970), so treat it as seconds.
  return n < 1e11 ? n * 1000 : n
}

function toBigInt(v: unknown): bigint | null {
  const n = num(v)
  if (n === null) return null
  if (!Number.isSafeInteger(Math.trunc(n))) return null
  return BigInt(Math.trunc(n))
}

function scaleOrNull(v: number | null, scale: number): number | null {
  return v === null ? null : v * scale
}

/** Scaling factor to convert a provider price into its major currency unit. */
function currencyScale(currency: string): number {
  return normalizeCurrencyAmount(1, currency).price
}

/** Module-level singleton — one client, one queue, for the process. */
export const yahooProvider = new YahooProvider()
