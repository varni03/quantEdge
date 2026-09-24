/**
 * Live smoke test for the market-data provider.
 *
 * Not a unit test — it deliberately hits the real upstream API. Its job is to answer
 * "is the free data source still working and still shaped the way we expect", which is the
 * single most likely thing to break in this app over time.
 *
 *   npx tsx scripts/smoke-provider.ts [SYMBOL]
 */

import { getProvider } from '@/lib/market/providers'
import { ProviderError } from '@/lib/market/provider'
import { marketStatusLabel, toSessionDate } from '@/lib/market/calendar'
import { sma } from '@/lib/quant/indicators'

const symbol = process.argv[2] ?? 'AAPL'

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits)
}

function heading(text: string): void {
  console.log(`\n${'─'.repeat(70)}\n${text}\n${'─'.repeat(70)}`)
}

async function main(): Promise<void> {
  const provider = getProvider()
  const now = new Date()
  const status = marketStatusLabel(now)

  heading(`provider: ${provider.name}   symbol: ${symbol}`)
  console.log(`market:  ${status.state} — ${status.label}`)
  console.log(`session: ${toSessionDate(now)} (New York)`)

  // ── quotes ────────────────────────────────────────────────────────────────
  heading('getQuotes (batched)')
  const quotes = await provider.getQuotes([symbol, 'SPY', 'MSFT'])
  console.log(
    ['symbol', 'price', 'prevClose', 'change%', 'state', 'currency'].join('\t').padEnd(10),
  )
  for (const q of quotes) {
    console.log(
      [
        q.symbol,
        fmt(q.price),
        fmt(q.previousClose),
        `${(q.changePercent * 100).toFixed(2)}%`,
        q.marketState,
        q.currency,
      ].join('\t'),
    )
  }
  if (quotes.length !== 3) {
    console.warn(`⚠️  expected 3 quotes, got ${quotes.length}`)
  }

  // ── bars ──────────────────────────────────────────────────────────────────
  heading('getBars (1 year, daily)')
  const from = new Date(Date.now() - 400 * 86_400_000)
  const bars = await provider.getBars(symbol, { from, interval: '1d' })
  console.log(`bars: ${bars.length}`)
  if (bars.length > 0) {
    const first = bars[0]
    const last = bars[bars.length - 1]
    console.log(`first: ${new Date(first.t).toISOString().slice(0, 10)}  close=${fmt(first.c)}  adj=${fmt(first.ac)}`)
    console.log(`last:  ${new Date(last.t).toISOString().slice(0, 10)}  close=${fmt(last.c)}  adj=${fmt(last.ac)}`)

    // Ascending order and uniqueness are contract requirements, so assert them.
    let ordered = true
    for (let i = 1; i < bars.length; i++) if (bars[i].t <= bars[i - 1].t) ordered = false
    console.log(`ascending & unique timestamps: ${ordered ? 'yes' : 'NO — contract violation'}`)

    // Adjusted vs raw divergence tells us whether adjustments are actually present.
    const divergence = Math.abs(first.ac / first.c - 1)
    console.log(
      `adj/raw divergence at series start: ${(divergence * 100).toFixed(2)}%` +
        (divergence < 1e-9 ? '  (no splits/dividends in window, or adjclose absent)' : ''),
    )

    // Prove the quant layer consumes these bars correctly.
    const closes = bars.map((b) => b.ac)
    const ma50 = sma(closes, 50)
    console.log(`sma(50) length matches input: ${ma50.length === closes.length ? 'yes' : 'NO'}`)
    console.log(`sma(50) latest: ${fmt(ma50[ma50.length - 1])}`)
    console.log(`sma(50) warm-up nulls: ${ma50.findIndex((v) => v !== null)} (expect 49)`)
  }

  // ── profile ───────────────────────────────────────────────────────────────
  heading('getProfile')
  const profile = await provider.getProfile(symbol)
  if (profile) {
    console.log(`name:      ${profile.name}`)
    console.log(`class:     ${profile.assetClass}`)
    console.log(`sector:    ${profile.sector ?? '—'} / ${profile.industry ?? '—'}`)
    console.log(`exchange:  ${profile.exchange ?? '—'} (${profile.currency})`)
    console.log(`mktCap:    ${profile.marketCap ?? '—'}`)
    console.log(`PE:        ${fmt(profile.peRatio)}   fwdPE: ${fmt(profile.forwardPe)}`)
    console.log(`divYield:  ${profile.dividendYield === null ? '—' : `${(profile.dividendYield * 100).toFixed(2)}%`}`)
    console.log(`provBeta:  ${fmt(profile.providerBeta)}`)
  } else {
    console.log('no profile returned')
  }

  // ── search ────────────────────────────────────────────────────────────────
  heading('search("apple")')
  for (const hit of await provider.search('apple', 5)) {
    console.log(`${hit.symbol.padEnd(10)} ${hit.assetClass.padEnd(12)} ${hit.name}`)
  }

  // ── corporate actions ─────────────────────────────────────────────────────
  heading('getCorporateActions (5y)')
  const actions = await provider.getCorporateActions(
    symbol,
    new Date(Date.now() - 5 * 365 * 86_400_000),
  )
  console.log(`dividends: ${actions.dividends.length}   splits: ${actions.splits.length}`)
  for (const s of actions.splits.slice(-3)) {
    console.log(`  split ${new Date(s.date).toISOString().slice(0, 10)}  ${s.numerator}:${s.denominator}`)
  }
  for (const d of actions.dividends.slice(-3)) {
    console.log(`  div   ${new Date(d.exDate).toISOString().slice(0, 10)}  ${fmt(d.amount, 4)}`)
  }

  // ── error mapping ─────────────────────────────────────────────────────────
  heading('error mapping (deliberately bad symbol)')
  try {
    await provider.getBars('ZZZZNOTREAL', { from: new Date(Date.now() - 30 * 86_400_000) })
    console.log('⚠️  expected an error, got a result')
  } catch (err) {
    if (err instanceof ProviderError) {
      console.log(`ProviderError code=${err.code}  (correctly normalized)`)
    } else {
      console.log(`⚠️  non-ProviderError leaked: ${(err as Error).name} — provider must normalize`)
    }
  }

  heading('done')
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED\n', err)
  process.exit(1)
})
