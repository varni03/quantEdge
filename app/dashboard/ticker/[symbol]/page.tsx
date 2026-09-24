/**
 * Per-ticker analysis page.
 *
 * A Server Component: it fetches market data and runs the indicator math server-side, then
 * hands plain serializable numbers to the client chart. Keeping the quant work on the server
 * means there is exactly one implementation of every indicator — the one the unit tests
 * reach — rather than a second copy in the browser that could silently disagree.
 */

import { notFound } from 'next/navigation'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AsOfBadge } from '@/components/as-of-badge'
import { Delta } from '@/components/delta'
import { Disclaimer } from '@/components/disclaimer'
import PriceChartLoader, { type OverlaySpec } from '@/components/charts/price-chart-loader'

import { getProvider } from '@/lib/market/providers'
import { ProviderError } from '@/lib/market/provider'
import { marketStatusLabel, toSessionDate } from '@/lib/market/calendar'
import { isPlausibleSymbol, normalizeSymbol } from '@/lib/market/symbols'
import { bollinger, ema, rsi, sma } from '@/lib/quant/indicators'
import { rawCloses } from '@/lib/quant/types'

/**
 * Market data changes continuously, so this page must never be prerendered at build time
 * with prices frozen into the HTML.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/dashboard/ticker/[symbol]'>) {
  const { symbol } = await props.params
  return { title: `${normalizeSymbol(symbol)} · quantEdge` }
}

export default async function TickerPage(props: PageProps<'/dashboard/ticker/[symbol]'>) {
  // Next 16 removed synchronous access to route params — `params` is a Promise and must be
  // awaited.
  const { symbol: rawSymbol } = await props.params
  const symbol = normalizeSymbol(decodeURIComponent(rawSymbol))

  if (!isPlausibleSymbol(symbol)) notFound()

  const provider = getProvider()
  const now = new Date()
  const status = marketStatusLabel(now)

  // ~2 years of sessions: enough to warm a 200-day average and still show it with history
  // in front of it.
  const from = new Date(now.getTime() - 730 * 86_400_000)

  let quote: Awaited<ReturnType<typeof provider.getQuotes>>[number] | undefined
  let bars: Awaited<ReturnType<typeof provider.getBars>> = []
  let profile: Awaited<ReturnType<typeof provider.getProfile>> = null
  let loadError: string | null = null

  try {
    // Fetched concurrently — three sequential round-trips would be needlessly slow, and the
    // provider's own queue plus our limiter keep this from becoming a fan-out problem.
    const [quotes, barsResult, profileResult] = await Promise.all([
      provider.getQuotes([symbol]),
      provider.getBars(symbol, { from, interval: '1d' }),
      provider.getProfile(symbol).catch(() => null),
    ])
    quote = quotes[0]
    bars = barsResult
    profile = profileResult
  } catch (err) {
    if (err instanceof ProviderError && (err.code === 'NOT_FOUND' || err.code === 'BAD_SYMBOL')) {
      notFound()
    }
    // A rate limit or upstream outage is not a 404. Showing an honest error beats rendering
    // a page full of dashes that looks like the ticker has no data.
    loadError =
      err instanceof ProviderError && err.code === 'RATE_LIMITED'
        ? 'The market-data provider is rate limiting requests. Try again in a moment.'
        : 'Market data is temporarily unavailable.'
  }

  if (loadError) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">{symbol}</h1>
        <Card className="mt-4">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      </main>
    )
  }

  if (bars.length === 0 && !quote) notFound()

  // ── indicator math, server-side ─────────────────────────────────────────────
  // Moving averages are drawn on the candles, so they use the same price series the candles
  // do — the split-adjusted close (`c`). Using the total-return close here would put the
  // line at a different level than the candles it's meant to describe.
  const closes = rawCloses(bars)
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  const ema20 = ema(closes, 20)
  const bands = bollinger(closes, 20, 2)
  const rsi14 = rsi(closes, 14)

  const chartBars = bars.map((b) => ({
    time: toSessionDate(new Date(b.t)),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }))

  // Colors are assigned by ENTITY (which indicator this is), never by array position, so
  // toggling one overlay off never repaints the others.
  const overlays: OverlaySpec[] = [
    {
      id: 'sma50',
      label: 'SMA 50',
      values: sma50,
      colorVar: '--series-1',
      defaultOn: true,
    },
    {
      id: 'sma200',
      label: 'SMA 200',
      values: sma200,
      colorVar: '--series-2',
      defaultOn: true,
    },
    { id: 'ema20', label: 'EMA 20', values: ema20, colorVar: '--series-7', defaultOn: false },
    {
      id: 'bb-upper',
      label: 'Boll upper',
      values: bands.upper,
      colorVar: '--series-3',
      lineWidth: 1,
      defaultOn: false,
    },
    {
      id: 'bb-lower',
      label: 'Boll lower',
      values: bands.lower,
      colorVar: '--series-3',
      lineWidth: 1,
      defaultOn: false,
    },
  ]

  const lastClose = closes.at(-1) ?? null
  const latestRsi = lastDefined(rsi14)
  const latestSma50 = lastDefined(sma50)
  const latestSma200 = lastDefined(sma200)

  // 52-week range position: where the price sits between its yearly low and high. More
  // informative than the raw high/low, and comparable across instruments.
  const high52 = quote?.fiftyTwoWeekHigh ?? null
  const low52 = quote?.fiftyTwoWeekLow ?? null
  const rangePos =
    high52 !== null && low52 !== null && high52 > low52 && lastClose !== null
      ? (lastClose - low52) / (high52 - low52)
      : null

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8">
      {/* ── header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{symbol}</h1>
            {profile?.assetClass && <Badge variant="secondary">{profile.assetClass}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {profile?.name ?? '—'}
            {profile?.exchange ? ` · ${profile.exchange}` : ''}
            {profile?.sector ? ` · ${profile.sector}` : ''}
          </p>
        </div>

        <div className="text-right">
          {quote ? (
            <>
              <div className="text-3xl font-semibold">
                {new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency: quote.currency,
                }).format(quote.price)}
              </div>
              <div className="mt-1 flex items-center justify-end gap-3">
                <Delta value={quote.change} format="currency" currency={quote.currency} size="sm" />
                <Delta value={quote.changePercent} format="percent" size="sm" />
              </div>
              <AsOfBadge
                state={status.state}
                label={status.label}
                asOf={quote.quoteTime}
                className="mt-2"
              />
            </>
          ) : (
            <AsOfBadge state={status.state} label={status.label} />
          )}
        </div>
      </div>

      {/* ── price chart ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price &amp; volume</CardTitle>
          <CardDescription>
            {bars.length} daily sessions. Prices are split-adjusted; returns math elsewhere in
            the app additionally accounts for dividends.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartBars.length > 0 ? (
            <PriceChartLoader bars={chartBars} overlays={overlays} height={440} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No price history available for this symbol.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── stat tiles ──
          Plain numbers, not charts — a single value's job is to be read, and eight
          categorical hues would add nothing. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="RSI (14)"
          value={latestRsi === null ? '—' : latestRsi.toFixed(1)}
          hint={
            latestRsi === null
              ? 'Not enough history'
              : latestRsi >= 70
                ? 'Above the conventional 70 threshold'
                : latestRsi <= 30
                  ? 'Below the conventional 30 threshold'
                  : 'Within the typical 30–70 band'
          }
        />
        <Stat
          label="Price vs SMA 200"
          value={
            latestSma200 === null || lastClose === null
              ? '—'
              : `${(((lastClose - latestSma200) / latestSma200) * 100).toFixed(1)}%`
          }
          hint={
            latestSma200 === null
              ? 'Needs 200 sessions'
              : lastClose !== null && lastClose > latestSma200
                ? 'Trading above its 200-day average'
                : 'Trading below its 200-day average'
          }
        />
        <Stat
          label="52-week range"
          value={rangePos === null ? '—' : `${(rangePos * 100).toFixed(0)}%`}
          hint={
            low52 !== null && high52 !== null
              ? `${low52.toFixed(2)} – ${high52.toFixed(2)}`
              : 'Range unavailable'
          }
        />
        <Stat
          label="Trend (50 vs 200)"
          value={
            latestSma50 === null || latestSma200 === null
              ? '—'
              : latestSma50 > latestSma200
                ? 'Above'
                : 'Below'
          }
          hint={
            latestSma50 === null || latestSma200 === null
              ? 'Needs 200 sessions'
              : `50-day ${latestSma50.toFixed(2)} vs 200-day ${latestSma200.toFixed(2)}`
          }
        />
      </div>

      {/* ── fundamentals ── */}
      {profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fundamentals</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Market cap" value={formatBigCurrency(profile.marketCap, profile.currency)} />
            <Stat
              label="P/E (trailing)"
              value={profile.peRatio === null ? '—' : profile.peRatio.toFixed(1)}
            />
            <Stat
              label="P/E (forward)"
              value={profile.forwardPe === null ? '—' : profile.forwardPe.toFixed(1)}
            />
            <Stat
              label="Dividend yield"
              value={
                profile.dividendYield === null
                  ? '—'
                  : `${(profile.dividendYield * 100).toFixed(2)}%`
              }
            />
          </CardContent>
        </Card>
      )}

      <Disclaimer
        variant="inline"
        context="Indicator readings are mechanical calculations, not predictions."
      />
    </main>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {/* Proportional figures for a standalone value; tabular is for aligned columns. */}
      <div className="mt-0.5 text-xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i]
    if (v !== null && Number.isFinite(v)) return v
  }
  return null
}

function formatBigCurrency(value: bigint | null, currency: string): string {
  if (value === null) return '—'
  const n = Number(value)
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ]
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      return `${new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(n / scale)}${suffix}`
    }
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
}
