/**
 * Verifies the adjusted-vs-raw close convention against a real stock split.
 *
 * This guards the highest-severity data bug in the app. On a split day the raw close drops
 * by the split ratio, so a returns series built from raw closes reports a catastrophic loss
 * that never happened. The adjusted close should show a normal day.
 *
 *   npx tsx scripts/check-splits.ts [SYMBOL] [FROM] [TO]
 *
 * Defaults to NVDA around its 10-for-1 split on 2024-06-10.
 */

import { getProvider } from '@/lib/market/providers'

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? 'NVDA'
  const from = new Date(process.argv[3] ?? '2024-05-28')
  const to = new Date(process.argv[4] ?? '2024-06-20')

  const provider = getProvider()
  const bars = await provider.getBars(symbol, { from, to })

  console.log(`\n${symbol}  ${bars.length} bars\n`)
  console.log('date          raw close    adj close    raw ret%    adj ret%')
  console.log('─'.repeat(66))

  let worstRaw = 0
  let worstAdj = 0

  for (let i = 1; i < bars.length; i++) {
    const date = new Date(bars[i].t).toISOString().slice(0, 10)
    const rawRet = (bars[i].c / bars[i - 1].c - 1) * 100
    const adjRet = (bars[i].ac / bars[i - 1].ac - 1) * 100

    if (Math.abs(rawRet) > Math.abs(worstRaw)) worstRaw = rawRet
    if (Math.abs(adjRet) > Math.abs(worstAdj)) worstAdj = adjRet

    const flag = Math.abs(rawRet) > 30 ? '  ← split day' : ''
    console.log(
      `${date}  ${bars[i].c.toFixed(2).padStart(10)}  ${bars[i].ac.toFixed(2).padStart(10)}` +
        `  ${rawRet.toFixed(2).padStart(9)}  ${adjRet.toFixed(2).padStart(9)}${flag}`,
    )
  }

  const actions = await provider.getCorporateActions(symbol, from)
  console.log('\nsplits reported by provider:')
  for (const s of actions.splits) {
    console.log(
      `  ${new Date(s.date).toISOString().slice(0, 10)}  ${s.numerator}:${s.denominator}`,
    )
  }
  if (actions.splits.length === 0) console.log('  (none in window)')

  console.log('\n─── verdict ───')
  console.log(`largest single-day raw return:      ${worstRaw.toFixed(2)}%`)
  console.log(`largest single-day adjusted return: ${worstAdj.toFixed(2)}%`)

  const hadSplit = actions.splits.length > 0
  const adjIsSane = Math.abs(worstAdj) < 30
  const rawIsSane = Math.abs(worstRaw) < 30

  if (!hadSplit) {
    console.log(
      '\n⚠️  INCONCLUSIVE — the provider reported no split in this window,\n' +
        '   so this run proves nothing. Pick a symbol/date range containing a known split.',
    )
    return
  }

  // What "correct" looks like depends on whether the provider pre-adjusts its OHLC.
  // Yahoo does, so the expected result is that *neither* series jumps. What must never
  // happen is a split-sized move in the adjusted series, because that would corrupt every
  // return, beta and correlation downstream.
  if (adjIsSane && rawIsSane) {
    console.log(
      '\n✅ PASS — a split occurred in this window and neither series shows a discontinuity.\n' +
        '   This provider pre-adjusts OHLC for splits, so `c` is price-return (split-adjusted,\n' +
        '   no dividends) and `ac` is total-return. Returns math must still use `ac` to capture\n' +
        '   dividend income — which is what lib/quant/returns.ts enforces.',
    )
  } else if (adjIsSane && !rawIsSane) {
    console.log(
      '\n✅ PASS — raw closes show the split discontinuity, adjusted closes do not.\n' +
        '   This provider does NOT pre-adjust OHLC. Candlestick rendering will show a cliff on\n' +
        '   the split date unless splits are applied for display too — worth fixing, but the\n' +
        '   returns math is safe because it uses `ac`.',
    )
  } else {
    console.log(
      '\n❌ FAIL — the adjusted series shows a split-sized jump.\n' +
        '   The provider is not returning a usable adjusted close; every return, beta and\n' +
        '   correlation computed from it would be wrong.',
    )
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
