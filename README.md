# quantEdge

A personal investing dashboard: track a portfolio, understand its risk, and learn what the
numbers actually mean.

The premise is that most retail tools show you *prices* and stop there. quantEdge computes the
things that actually describe a portfolio — volatility, beta, Sharpe, drawdown, correlation,
concentration — and then explains each one in plain English next to the number itself.

> quantEdge provides educational analytics based on market data you choose to track. It is not
> investment advice, not a recommendation to buy or sell any security, and not a solicitation.
> Market data may be delayed, incomplete, or inaccurate. Past performance does not indicate
> future results.

---

## Running it

Requires **Node 22+** (pinned to 24.18.1 in `.nvmrc`; `yahoo-finance2` v4 requires 22+).

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL + DATABASE_PASSWORD
npx drizzle-kit migrate        # create the tables
npx tsx scripts/seed.ts --demo # seed a user + sample portfolio
npm run dev                    # → http://localhost:3000
```

Then open **http://localhost:3000/dashboard/ticker/AAPL**.

```bash
npm run typecheck              # tsc --noEmit
npm run lint                   # also enforces the provider-import restriction
npm test                       # Vitest (watch)
npm run test:coverage          # gate: lib/quant/** and lib/portfolio/** ≥95%
npm run precommit              # typecheck + tests
```

Diagnostic scripts that hit the live data source:

```bash
npx tsx scripts/smoke-provider.ts AAPL   # is the free data source still working & shaped right?
npx tsx scripts/check-splits.ts          # does the adjusted-close convention survive a real split?
npx tsx scripts/check-db.ts               # why won't the database connect?
npx tsx scripts/db-stats.ts               # cache + holdings state
npx tsx scripts/validate-quant.ts         # does the quant engine agree with reality?
npx tsx scripts/debug-correlation.ts      # is a correlation figure believable?
npx tsx scripts/bench-db.ts               # where is page time actually going?
npx tsx scripts/check-alerts.ts --test-dedupe   # do alerts fire, and does dedupe hold?
npx tsx scripts/check-ai.ts               # do the AI guardrails actually hold?
npx tsx scripts/seed-demo.ts --reset      # a demo portfolio built to exercise the analysis
```

`smoke-provider` is the first thing to run when something looks wrong. Yahoo is an unofficial
API, so "did upstream change" is a real and recurring hypothesis.

---

## Build status

| Phase | What it delivers | Status |
|---|---|---|
| 0 | Node toolchain | **done** |
| 1 | App skeleton, market-data layer, candlestick chart, ticker page | **done** |
| 2 | Supabase persistence, holdings, portfolio page | **done** |
| 3 | Quant engine + Vitest suite, risk & performance pages | **done** |
| 4 | Signals, market overview, sector heatmap | **done** |
| 5 | Watchlists, alerts, delivery | **done** |
| 6 | AI insights & education layer | **done** |
| 7 | Onboarding, sharing, deploy | **done** |

Deferred ideas live in [`V2.md`](./V2.md) — deliberately, so they don't leak into the current
phase.

---

## Architecture — the decisions that matter

### The data source is behind a seam, on purpose

`yahoo-finance2` is free and needs no signup, which is why it's here. It's also **unofficial** —
its own README says Yahoo provides no developer API and makes no guarantee of availability or
shape. So it's treated as a scaffold with a known expiry date:

- Only `lib/market/providers/yahoo.ts` may import it. **An ESLint rule fails the build
  otherwise**, so the convention can't quietly rot.
- Everything else goes through the `MarketDataProvider` interface in `lib/market/provider.ts`.
- Replacing it (Tiingo, Polygon) is one new file plus an env var.

### The database is the source of truth for price history, not a cache

Free tiers rate-limit hard, and a 30-position dashboard can fan out to hundreds of requests.
`price_bars` is written once per session and never re-fetched; fetches are strictly incremental
from the last stored session. **Steady state, a dashboard load makes zero bar requests.**

Correctness deliberately does not depend on framework caching. `use cache` / Cache Components is
*not* enabled — on serverless its entries don't persist across requests, so it wouldn't solve
the rate-limit problem the database tier already solves. See `next.config.ts`.

### Adjusted vs raw close — the highest-severity data trap

Every bar carries two closes, and mixing them up is the classic quant bug:

- `Bar.c` — **price return**: split-adjusted, no dividends. Used for candlestick rendering.
- `Bar.ac` — **total return**: adjusted for splits *and* dividends. Used for every return,
  volatility, beta, drawdown and correlation.

`lib/quant/returns.ts` accepts only `ac`-derived series. Verified against NVDA's 10-for-1 split
(2024-06-10) with `scripts/check-splits.ts`: Yahoo pre-adjusts OHLC for splits, so neither
series jumps — but using `c` for returns would still silently discard all dividend income, which
compounds into a badly wrong performance figure over years.

### Money is never a float

`0.1 + 0.2 === 0.30000000000000004`. Sum a few hundred transactions in float and the cost basis
is visibly wrong — and a portfolio tracker whose totals don't reconcile destroys trust in every
other number it shows, including the Sharpe ratio.

Money is `bigint` cents in the database, in TypeScript, and a decimal string over JSON
(`JSON.stringify` throws on `bigint`). All arithmetic goes through `lib/money.ts`, where
**rounding happens exactly once, at a named and tested boundary.** Share quantities are
`numeric(24,8)`; ratios and metrics are plain floats, which is the right type for a Sharpe ratio.

### Timezones go through the market calendar, always

A session is identified by a `yyyy-MM-dd` string in **New York** terms, never by a `Date` — a
`Date` is an instant, and the same instant is a different calendar day depending on where you
stand. `new Date().getHours()` appears nowhere; this machine is set to Asia/Hong_Kong and would
compute the wrong session. `lib/market/calendar.ts` is the only authority on what a trading day
is, including holidays and 1pm half-days.

For multi-symbol math, series are **inner-joined on session date** with a post-join length
assertion — a one-day misalignment silently corrupts every beta and correlation in the app.

### Every signal states its own rule and shows its evidence

A signal that says "Golden Cross · bullish" is an oracle. One that says *"the 50-day average crossed
above the 200-day two sessions ago; 50-day is 189.40, 200-day is 187.10"* is analysis, because the
reader can check it. The `Signal` type makes the second mandatory: `rule`, `evidence` and `caveat`
are all required fields, and a test asserts the property across every rule that fires.

Three things are deliberately absent from the type: there is no `action`, no `rating`, no
`priceTarget`. A signal describes what a rule observed. Aggregate stance is reported as a count
("4 of 6 directional rules bullish") rather than a verdict, and `confidence` means "how completely
the rule's criteria were met" — never a probability that a price will move.

The rules themselves are conventional technical patterns whose predictive evidence is weak and
contested. They're included because "price is above its 200-day average" is a compact fact worth
knowing, and because a reader who sees the rule stated can judge it for themselves. Every caveat
says so.

### Share links are capability URLs, and are treated as such

Possession of the token is the authorization, so the token's properties are load-bearing rather
than cosmetic: 160 bits from `crypto.randomBytes` (never `Math.random`, which is seeded from
predictable state and enumerable), `noindex` (a capability URL Google has crawled is no longer a
capability), a required expiry, and **`hideAmounts` defaulting to true** — sharing a portfolio
usually means sharing its shape, not its size. Revoking marks the link withdrawn rather than
deleting it, so a recipient sees "this was withdrawn" instead of a 404 that reads as a broken app.

The report page is scoped by the **token's** `userId`, never `getCurrentUserId()` — which would
resolve to the single-user default and serve the wrong person's portfolio the moment auth exists.

### The demo portfolio is built to exercise the analysis, not to look good

`scripts/seed-demo.ts` seeds 11 instruments across 7 sectors plus bonds, priced from **real
historical bars** on each purchase date rather than invented numbers. Five megacap tech stocks
bought last month would make every chart useless — correlations near 1, no drawdown, and a
risk-contribution panel where weight and risk are identical.

So it deliberately includes: purchases from 2022 so the drawdown chart covers a real decline;
genuine losers (PFE, INTC) alongside winners; two NVDA lots at very different prices so FIFO/LIFO/
average actually differ; and a partial sale plus a dividend so realized gains and income are
non-empty. The result surfaces the app's best insight immediately — **INTC at 6.1% of value but
18.2% of risk**, and VOO/VTI correlating at 1.00, "effectively one bet".

### The AI layer narrates; it never computes

The quant engine produces every number. The model turns those numbers into sentences. That
separation is enforced in code by three mechanisms, in increasing order of strength:

**1. The schema has no advice-shaped field.** No `action`, no `rating`, no `priceTarget`, no
`outlook`. The model cannot emit a recommendation because there is nowhere to put one — a
structural guarantee rather than a request. A test asserts the forbidden names stay absent, so
nobody re-adds `priceTarget` six months from now without the suite objecting.

**2. Every number must cite its source, and is checked.** Each item carries `metricRefs` — dotted
paths into the computed context. After generation, every number-shaped token in the prose is
matched against the cited values, format-tolerantly (`0.0247`, `2.47%` and `$1,240` can all render
the same underlying figure). **An item with a number that cannot be traced is dropped**, not
flagged. A warning badge next to a wrong number still shows the number.

Two lessons from running this against the live API rather than reasoning about it. First, the
verifier was **too strict**: it dropped items for quoting "the last 60 sessions" out of a cited
signal rule, and for writing "the 95% value at risk" where the 95 names the metric rather than
claiming anything. False positives are not free — a dropped item leaves no trace, so the narration
silently gets thinner than the data supports. Numbers embedded in cited strings and in cited path
names are now licensed.

Second, and worse, the leniency that made it usable had punched a hole straight through it. The
rounding tolerance applied `Math.round` at any magnitude, and everything below 0.5 rounds to zero —
so **any fabricated fraction matched any other fraction**. A made-up beta of 0.42 verified happily
against a real R-squared of 0.81. Ratios (beta, Sharpe, correlation, R²) live almost entirely in
that range, so this defeated the guarantee across most of the metrics that matter. Integer rounding
is now gated to values of at least 1, with a regression test.

**3. Advisory language is rejected by pattern.** The weakest of the three, and deliberately last.
It enforces one distinction: *"your volatility is 24%, roughly 1.6× the S&P 500's"* is analysis;
*"you should reduce risk"* is advice. Second-person observations are fine; second-person
imperatives about future action are not. Tests cover both directions — guardrails that reject
legitimate description would gut the feature as surely as guardrails that permit advice.

What this does **not** catch: a correctly quoted number placed in a false relationship. The narrow
schema and short prose fields are what limit the room for that.

### The glossary is hand-written, deliberately

~33 metric definitions, each with `plainEnglish`, `howToRead`, `formula`, `caveats` and a typical
range. Not generated, for three reasons: a definition that drifts between page loads teaches the
reader to distrust both versions; these are the reference everything else is measured against, so
they need review rather than re-derivation; and rendering a dozen tiles would mean a dozen calls
for text that never changes.

The `caveats` field earns the file's keep. Every one of these metrics is routinely quoted without
its limitations, and the limitation is usually what a beginner most needs — *"correlations rise
during market stress, so a calm-period figure overstates the protection available in a crisis."*

The `/dashboard/learn` page shows **your own number beside each definition**, which is what makes
a definition stick.

### Prompt caching needs a frozen prefix

The system prompts are module constants, never template functions. Interpolating anything volatile
— today's date, a portfolio value, a user id — changes the cached prefix and guarantees a miss on
every call. Nothing breaks; the bill just quietly triples. `scripts/check-ai.ts` asserts
`cache_read_input_tokens > 0` on the second call, which is the only reliable proof it works.

Briefs are also cached in `ai_briefs` on a hash of the context, so cost scales with distinct
portfolio *states* rather than with page views.

### Alerts are designed around not firing too often

The failure mode that kills an alerts feature is not a missed alert — it is too many. An RSI rule
with no guard fires every time the value oscillates across its threshold, the user mutes everything,
and the feature is dead. Three independent mechanisms prevent that:

- **Edge triggering.** Rules fire on the *crossing*, not the state. "Price above $200" fires once
  when it crosses, not every 15 minutes for the week it stays there.
- **Cooldown.** A rule goes quiet for a configurable period after firing; the floor is 15 minutes
  and the default is a day.
- **Database-enforced de-duplication.** A unique index on
  `(alert_rule_id, evidence_hash, session_date)` means the same rule with the same triggering
  numbers on the same day produces one notification. This has to be the database's job because
  three independent triggers can run concurrently — application-level checking would race.

The rule builder **backtests before you save**, which is the feature that makes the rest usable:
nobody has intuition for whether "RSI above 70" means one alert a quarter or three a week, and it
tells you *"would have fired 3 times in the last 90 sessions — about 0.7 per month"* before you
commit.

Every notification stores the exact numbers that fired it, so "why did this alert?" is answerable
from the notification alone.

### Delivery: three triggers, because no single free scheduler works

Vercel's free tier runs cron **once a day**, with up to an hour of jitter. So:

1. **Vercel Cron**, nightly after the close — end-of-day rules, and a keep-alive that stops the free
   Supabase project auto-pausing after ~7 days idle.
2. **GitHub Actions**, every 15 minutes during market hours — `curl` to the same endpoint. Free, and
   its logs are visible. GitHub's scheduler is best-effort and commonly runs 5–15 minutes late;
   that's expected, and the alerts page says so rather than implying a reliability it can't offer.
3. **Evaluate-on-visit** — an opportunistic pass when you open the dashboard.

All three hit `POST /api/cron/evaluate-alerts`, guarded by `CRON_SECRET`. **The endpoint fails
closed**: an unset secret returns 503 rather than running unauthenticated, so a forgotten
environment variable can never leave a job endpoint publicly triggerable.

### Page latency is round trips, not computation

Pages were taking **minutes**. The cause was not the maths — it was that the database is remote
(this machine is in Hong Kong, the Supabase pooler is in us-east-1, measured median latency ~140ms
per query) and the code made one query per symbol. The signals loader was the worst offender: it
re-fetched the benchmark once per holding, about 72 sequential queries for an eight-position table.

Bar and profile reads are now **batched into a single query**. Measured on nine symbols: 5,043ms
→ 508ms. The pages went from 231s and 148s to about one second each. `scripts/bench-db.ts` exists
to catch a regression.

The general lesson, written here because it will recur: when something is slow, count the round
trips before optimizing the algorithm.

### Correctness is checked at two levels, because unit tests alone aren't enough

**399 unit tests** cover the pure functions, at 97% statement coverage on `lib/quant`,
`lib/portfolio`, `lib/money.ts` and the market calendar. They prove the maths is self-consistent
and pin down the edge cases that silently produce garbage: a zero-volatility Sharpe returns `null`
rather than `Infinity`, risk contributions sum to exactly 1, a mid-period deposit leaves
time-weighted return unchanged, `beta(x, x) === 1`.

But self-consistent is not the same as *right* — a formula can be internally coherent and still
disagree with every other tool in the world. So `scripts/validate-quant.ts` runs the engine against
**real market data and independently-known values**:

- The S&P 500's H1 2020 drawdown computes to **−33.7%**, peaking 19 Feb and troughing 23 Mar —
  matching the historical record.
- `beta(SPY, SPY)` is exactly 1; `beta(2×SPY, SPY)` is exactly 2.
- Risk contributions sum to 1 on real covariance data (this catches a transposed matrix).
- Coca-Cola's total return exceeds its price return by 13 percentage points over three years —
  which *is* the dividend income, and proves the adjusted-close convention is live rather than
  merely documented.

The two layers catch different failures. Unit tests catch wrong formulas; the real-data checks
catch correct formulas wired together wrongly — which is what actually went wrong twice during
Phase 3.

---

## Layout

```
app/
  dashboard/ticker/[symbol]/   per-ticker analysis (Phase 1)
lib/
  quant/          PURE math — no React, no DB, no fetch. Where the tests live.
  market/         provider interface, Yahoo impl, rate limiter, NYSE calendar
  money.ts        bigint-cent arithmetic; the only sanctioned money path
  portfolio/      lot engine, NAV, performance          (Phase 2–3)
  signals/        rule engine                            (Phase 4)
  ai/             context, schemas, numeric verification (Phase 6)
components/
  charts/         lightweight-charts wrapper + client loader
  delta.tsx       gain/loss display — enforces "never color alone"
  disclaimer.tsx  compliance text, four placements
scripts/          live diagnostics against the real data source
```

### Charts

Two libraries, because neither covers the other's job. **lightweight-charts** for anything
price-shaped (candlesticks, volume panes, indicator overlays, pan/zoom) — Recharts has no
candlestick primitive. **Recharts**, via shadcn's `chart`, for everything else: allocation
donuts, NAV vs benchmark, drawdown, heatmaps, risk contribution, Monte Carlo fans.

The palette in `app/globals.css` was validated with the dataviz palette validator against this
app's actual chart surfaces, not defaults. Two rules come out of that and are documented inline:

- **Form dictates the series cap.** Donuts, scatter and heatmap categories — where any series
  can sit beside any other — use the first **three** slots only. Bars, lines and stacks may use
  all eight. Past the cap, fold into "Other" or facet.
- **The relief rule.** Three light-mode slots fall below 3:1 contrast on white; wherever they
  appear, a visible direct label or the table view is mandatory.

Gain/loss keeps the green/red convention users expect, but **color is never the only channel** —
every delta also carries an explicit sign and a ▲/▼ glyph, because roughly 8% of men can't
separate those two hues. That's what `components/delta.tsx` exists to enforce.

---

## Operational notes

Things that will otherwise look like bugs:

- **Node breaking.** It already did once — `/usr/local/bin/node` was a dangling symlink into an
  empty Homebrew Cellar, and the `/usr/local` Homebrew is an unusable x86 build on this arm64
  Mac. Node now lives at `~/.local/node` (official arm64 tarball, symlinked into
  `~/.local/bin`, which is first on `PATH`). To recover: download
  `node-v24.18.1-darwin-arm64.tar.gz` from nodejs.org, extract to `~/.local`, re-point the
  `~/.local/node` symlink. Don't try to fix Homebrew.
- **Supabase free projects pause after ~7 days idle** (Phase 2+). The daily cron doubles as a
  keep-alive. A paused project looks exactly like a broken app.
- **Vercel's free cron runs once per day, ±59 min** (Phase 5). Intraday alerts therefore run
  from a GitHub Actions schedule hitting the same endpoint. GitHub's scheduler is best-effort
  and can lag 5–15 minutes — that's expected, not a fault.
- **Never put the database password inside `DATABASE_URL`.** Set `DATABASE_PASSWORD`
  separately; it is passed to the driver verbatim. A password in a connection URL must be
  percent-encoded, and an unescaped `@` silently truncates it — which the server reports as
  "password authentication failed", indistinguishable from a genuinely wrong password. This
  cost real debugging time before the architecture changed to make it impossible.
- **The database password is not your Supabase account login.** It's a separate per-project
  credential, shown once at creation. If unsaved, resetting is the only way to recover it.
- **Two drawdown figures on the risk page are both correct.** The metric tile applies *today's*
  weights across all history (consistent with the other risk metrics, and a hypothetical); the
  chart shows what actually happened to the real account as it was built up. They can differ
  substantially. Both are labelled.
- **`next lint` no longer exists** in Next 16 and `next build` no longer lints. Run
  `npm run lint` yourself.
- **A known Next advisory** (`GHSA-6gpp-xcg3-4w24`, Proxy bypass in App Router with Turbopack)
  has no stable fix as of 16.2.12. v1 has no auth middleware so nothing is exposed, but it is a
  gate before auth goes in — see `V2.md`.
# quantEdge
