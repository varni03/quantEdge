/**
 * Money arithmetic.
 *
 * Money is represented as `bigint` minor units (US cents) everywhere: in the database, in
 * TypeScript, and as a decimal string over JSON. Never as a float.
 *
 * Why this matters more than it looks: `0.1 + 0.2 === 0.30000000000000004`. Sum a few
 * hundred transactions in float and the cost basis is visibly wrong by a cent or two. A
 * portfolio tracker whose totals don't reconcile is a portfolio tracker nobody trusts, and
 * once the user distrusts the cost basis they have no reason to trust the Sharpe ratio
 * either. Exactness here is what makes every other number in the app credible.
 *
 * The rule this module exists to enforce: **rounding happens exactly once, at a named and
 * tested boundary** — never incidentally in the middle of a chain of arithmetic.
 */

/** A quantity of shares. Fractional shares are real, so this is a float by necessity. */
export type Quantity = number

/** Money as integer minor units (cents). */
export type Cents = bigint

export const ZERO: Cents = 0n

/** Rounding mode for the one place where a rounding decision is unavoidable. */
export type RoundingMode = 'half-up' | 'half-even' | 'trunc'

// ── construction ────────────────────────────────────────────────────────────────

/**
 * Parse user-entered money ("1,234.56", "$1234.5", "1234") into exact cents.
 *
 * Deliberately string-based rather than `Math.round(parseFloat(x) * 100)`: that route sends
 * the value through a float and can land a cent off for values a float can't represent.
 * Here the decimal digits are read directly, so the result is exact by construction.
 *
 * @throws if the input isn't a parseable money amount.
 */
export function parseUserMoney(input: string | number): Cents {
  const raw = String(input).trim().replace(/[$,\s]/g, '')
  if (raw === '') throw new Error('parseUserMoney: empty input')

  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw)
  if (!m) throw new Error(`parseUserMoney: not a money amount: ${JSON.stringify(input)}`)

  const [, sign, whole = '', frac = ''] = m
  if (whole === '' && frac === '') {
    throw new Error(`parseUserMoney: not a money amount: ${JSON.stringify(input)}`)
  }

  // Take two decimal places exactly; round the third if present.
  const cents2 = (frac + '00').slice(0, 2)
  let value = BigInt(whole === '' ? '0' : whole) * 100n + BigInt(cents2)

  const third = frac.charCodeAt(2) - 48
  if (third >= 5 && third <= 9) value += 1n // half-up on the discarded remainder

  return sign === '-' ? -value : value
}

/** Cents from a whole number of dollars. Exact, no float involved. */
export function dollars(whole: number | bigint): Cents {
  return BigInt(whole) * 100n
}

// ── arithmetic ──────────────────────────────────────────────────────────────────

export function addCents(...values: Cents[]): Cents {
  let total = 0n
  for (const v of values) total += v
  return total
}

export function subCents(a: Cents, b: Cents): Cents {
  return a - b
}

export function negateCents(a: Cents): Cents {
  return -a
}

export function absCents(a: Cents): Cents {
  return a < 0n ? -a : a
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n
  for (const v of values) total += v
  return total
}

/**
 * Multiply an exact cent amount by a possibly-fractional share quantity.
 *
 * This is the one operation that genuinely cannot stay in integer space — share counts are
 * fractional — so it is also the single sanctioned rounding boundary. It is scaled through
 * a large integer factor so the float only ever participates in one multiplication, and the
 * rounding decision is explicit rather than emergent.
 */
export function mulCentsByQty(
  cents: Cents,
  qty: Quantity,
  mode: RoundingMode = 'half-up',
): Cents {
  if (!Number.isFinite(qty)) throw new Error(`mulCentsByQty: non-finite quantity ${qty}`)
  if (qty === 0 || cents === 0n) return 0n

  // Scale the quantity to an integer at 1e8 precision — matching numeric(24,8) in the DB,
  // so a quantity that round-trips through Postgres multiplies identically here.
  const SCALE = 100_000_000n
  const scaledQty = BigInt(Math.round(qty * 1e8))

  const product = cents * scaledQty // exact, in units of 1e-8 cents
  return divRound(product, SCALE, mode)
}

/**
 * Integer division with an explicit rounding mode, correct for negative numerators.
 * Exported because it is the primitive every other rounding path here is built on.
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator === 0n) throw new Error('divRound: division by zero')

  const negative = numerator < 0n !== denominator < 0n
  const absNum = numerator < 0n ? -numerator : numerator
  const absDen = denominator < 0n ? -denominator : denominator

  const quotient = absNum / absDen
  const remainder = absNum % absDen
  if (remainder === 0n) return negative ? -quotient : quotient

  let rounded = quotient
  if (mode === 'trunc') {
    rounded = quotient
  } else {
    const twice = remainder * 2n
    if (twice > absDen) {
      rounded = quotient + 1n
    } else if (twice === absDen) {
      // Exact tie.
      rounded =
        mode === 'half-even'
          ? quotient % 2n === 0n
            ? quotient
            : quotient + 1n
          : quotient + 1n // half-up
    }
  }

  return negative ? -rounded : rounded
}

/**
 * Divide cents by a share quantity to get cents-per-share (e.g. average cost).
 * Returns `null` for a zero quantity rather than throwing or yielding Infinity —
 * a closed position legitimately has no per-share cost.
 */
export function centsPerShare(
  cents: Cents,
  qty: Quantity,
  mode: RoundingMode = 'half-up',
): Cents | null {
  if (!Number.isFinite(qty) || qty === 0) return null
  const SCALE = 100_000_000n
  const scaledQty = BigInt(Math.round(qty * 1e8))
  if (scaledQty === 0n) return null
  return divRound(cents * SCALE, scaledQty, mode)
}

/**
 * Ratio of two cent amounts as a plain float — for percentages and metrics, where
 * exact decimal representation is not required and float is the right type.
 * Returns `null` when the denominator is zero instead of `Infinity` or `NaN`.
 */
export function divCentsToRatio(numerator: Cents, denominator: Cents): number | null {
  if (denominator === 0n) return null
  return Number(numerator) / Number(denominator)
}

// ── conversion at the edges ─────────────────────────────────────────────────────

/**
 * Cents → float dollars. **Display and chart-plotting only.**
 * Never feed the result back into money arithmetic.
 */
export function centsToNumber(cents: Cents): number {
  return Number(cents) / 100
}

/**
 * Cents → decimal string, for JSON transport.
 * `JSON.stringify` throws on `bigint`, so every API boundary must convert explicitly.
 */
export function centsToString(cents: Cents): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = abs / 100n
  const frac = abs % 100n
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`
}

/** Inverse of {@link centsToString}, for reading values back off the wire. */
export function stringToCents(value: string): Cents {
  return parseUserMoney(value)
}

// ── formatting ──────────────────────────────────────────────────────────────────

/**
 * Format cents for display. Uses `Intl.NumberFormat`, which handles the currency symbol,
 * grouping separators and locale conventions.
 */
export function formatCents(
  cents: Cents,
  currency = 'USD',
  locale = 'en-US',
  opts: { showSign?: boolean; compact?: boolean } = {},
): string {
  const value = centsToNumber(cents)
  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 2,
    minimumFractionDigits: opts.compact ? 0 : 2,
  }).format(value)

  // `Intl` already renders a minus sign; only a leading plus needs adding.
  if (opts.showSign && cents > 0n) return `+${formatted}`
  return formatted
}

/**
 * Format a decimal ratio as a percentage. Percentages are stored as decimals
 * (`0.0247`) and formatted only at the edge — never stored as `"2.47%"`.
 */
export function formatPercent(
  ratio: number | null,
  opts: { digits?: number; showSign?: boolean } = {},
): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  const digits = opts.digits ?? 2
  const pct = ratio * 100
  const body = `${pct.toFixed(digits)}%`
  if (opts.showSign && pct > 0) return `+${body}`
  return body
}

/**
 * Format a share quantity, trimming trailing zeros but never rounding a real position
 * away to zero — a holding of 0.001 shares must not display as "0".
 */
export function formatQuantity(qty: Quantity, maxDigits = 6): string {
  if (!Number.isFinite(qty)) return '—'
  if (Number.isInteger(qty)) return qty.toLocaleString('en-US')
  const fixed = qty.toFixed(maxDigits).replace(/0+$/, '').replace(/\.$/, '')
  return fixed === '0' || fixed === '-0' ? qty.toExponential(2) : fixed
}
