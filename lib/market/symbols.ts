/**
 * Ticker symbol normalization and validation.
 *
 * v1 supports US-listed equities and ETFs. Foreign symbols are *recognized* but flagged,
 * because a non-USD holding silently summed into a USD portfolio total is worse than one
 * that's visibly excluded — a wrong total is indistinguishable from a right one until the
 * user notices it doesn't match their brokerage.
 */

/** Canonical form: uppercase, trimmed, no surrounding punctuation. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

/**
 * Structural validity only — this says the string *looks* like a ticker, not that it exists.
 * Existence is a provider question, answered by `search()` or a failed `getProfile()`.
 *
 * Accepts the shapes that actually occur: plain tickers (`AAPL`), class shares
 * (`BRK.B`), exchange suffixes (`VOD.L`, `0700.HK`), and index carets (`^GSPC`).
 */
export function isPlausibleSymbol(symbol: string): boolean {
  const s = normalizeSymbol(symbol)
  if (s.length === 0 || s.length > 20) return false
  return /^\^?[A-Z0-9]{1,10}(?:[.-][A-Z0-9]{1,6})*$/.test(s)
}

/**
 * Exchange suffix, if any. Yahoo appends a dot-suffix for non-US listings
 * (`.L` London, `.HK` Hong Kong, `.TO` Toronto). US listings carry no suffix.
 *
 * Careful: `BRK.B` is a US class-share ticker, not a suffixed foreign listing. The
 * distinction is that share classes are a single letter and known exchange codes are in the
 * table below, so we match against the table rather than guessing from shape.
 */
const KNOWN_EXCHANGE_SUFFIXES = new Set([
  'L', // London
  'HK', // Hong Kong
  'TO', // Toronto
  'V', // TSX Venture
  'AX', // Australia
  'T', // Tokyo
  'SS', // Shanghai
  'SZ', // Shenzhen
  'PA', // Paris
  'DE', // XETRA
  'F', // Frankfurt
  'AS', // Amsterdam
  'BR', // Brussels
  'MI', // Milan
  'MC', // Madrid
  'ST', // Stockholm
  'HE', // Helsinki
  'CO', // Copenhagen
  'OL', // Oslo
  'SW', // Swiss
  'NS', // India NSE
  'BO', // India BSE
  'SI', // Singapore
  'KS', // Korea
  'TW', // Taiwan
  'SA', // Brazil
  'MX', // Mexico
  'NZ', // New Zealand
  'JO', // Johannesburg
  'TA', // Tel Aviv
])

export function exchangeSuffix(symbol: string): string | null {
  const s = normalizeSymbol(symbol)
  const idx = s.lastIndexOf('.')
  if (idx <= 0) return null
  const suffix = s.slice(idx + 1)
  return KNOWN_EXCHANGE_SUFFIXES.has(suffix) ? suffix : null
}

/** True when the symbol is a US listing (no recognized foreign exchange suffix). */
export function isUsSymbol(symbol: string): boolean {
  return exchangeSuffix(symbol) === null
}

/** True for an index symbol like `^GSPC` or `^VIX`. */
export function isIndexSymbol(symbol: string): boolean {
  return normalizeSymbol(symbol).startsWith('^')
}

/**
 * Currencies quoted in minor units by convention, where the provider's price is in pence
 * rather than pounds. London is the notorious case: `VOD.L` comes back as `GBp`, so a naive
 * reading overstates the price by 100×.
 */
export function isMinorUnitCurrency(currency: string): boolean {
  return currency === 'GBp' || currency === 'ZAc' || currency === 'ILA'
}

/** Convert a minor-unit quoted price into its major unit, and report the real currency. */
export function normalizeCurrencyAmount(
  price: number,
  currency: string,
): { price: number; currency: string } {
  if (!isMinorUnitCurrency(currency)) return { price, currency }
  const major: Record<string, string> = { GBp: 'GBP', ZAc: 'ZAR', ILA: 'ILS' }
  return { price: price / 100, currency: major[currency] ?? currency }
}

/** Benchmarks and reference symbols the app uses by default. */
export const DEFAULT_BENCHMARK = 'SPY'

/** Index/ETF symbols shown in the market-pulse strip. */
export const MARKET_PULSE_SYMBOLS = ['SPY', 'QQQ', 'IWM', '^VIX'] as const

/**
 * The 11 SPDR sector ETFs, used as sector proxies for the heatmap and for
 * relative-strength comparisons. Using tradeable ETFs rather than raw sector indices means
 * the numbers reflect something a user could actually have owned.
 */
export const SECTOR_ETFS: ReadonlyArray<{ symbol: string; sector: string }> = [
  { symbol: 'XLK', sector: 'Technology' },
  { symbol: 'XLV', sector: 'Healthcare' },
  { symbol: 'XLF', sector: 'Financials' },
  { symbol: 'XLY', sector: 'Consumer Discretionary' },
  { symbol: 'XLP', sector: 'Consumer Staples' },
  { symbol: 'XLE', sector: 'Energy' },
  { symbol: 'XLI', sector: 'Industrials' },
  { symbol: 'XLB', sector: 'Materials' },
  { symbol: 'XLU', sector: 'Utilities' },
  { symbol: 'XLRE', sector: 'Real Estate' },
  { symbol: 'XLC', sector: 'Communication Services' },
]

/** Map a sector name onto its proxy ETF, for relative-strength comparisons. */
export function sectorEtfFor(sector: string | null | undefined): string | null {
  if (!sector) return null
  const match = SECTOR_ETFS.find((s) => s.sector.toLowerCase() === sector.toLowerCase())
  return match?.symbol ?? null
}
