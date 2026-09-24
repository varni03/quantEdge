/**
 * Gain/loss display.
 *
 * Every change value in the app renders through this component, which exists to enforce one
 * rule: **direction is never carried by color alone.**
 *
 * Roughly 8% of men have red-green color vision deficiency, and green-up/red-down is exactly
 * the pairing they cannot separate. Abandoning the convention isn't the answer — it's what
 * every brokerage uses and violating it would confuse everyone else. So the color stays, and
 * an explicit sign plus a direction glyph rides along with it. The sign is what a colorblind
 * user actually reads; the color is a fast path for everyone else.
 */

import { cn } from '@/lib/utils'
import { formatPercent } from '@/lib/money'

export type DeltaSize = 'sm' | 'md' | 'lg'

export interface DeltaProps {
  /** The change. `null` renders an em dash — an unknown value is not a zero value. */
  value: number | null
  /** `percent` treats `value` as a decimal fraction (0.0247 → "+2.47%"). */
  format?: 'percent' | 'currency' | 'number'
  currency?: string
  digits?: number
  size?: DeltaSize
  /** Hide the ▲/▼ glyph. Only safe where an adjacent element already encodes direction. */
  hideGlyph?: boolean
  className?: string
}

const sizeClasses: Record<DeltaSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
}

export function Delta({
  value,
  format = 'percent',
  currency = 'USD',
  digits,
  size = 'md',
  hideGlyph = false,
  className,
}: DeltaProps) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <span className={cn('text-muted-foreground tabular', sizeClasses[size], className)}>—</span>
    )
  }

  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  const color =
    direction === 'up'
      ? 'var(--gain)'
      : direction === 'down'
        ? 'var(--loss)'
        : 'var(--neutral-delta)'
  const glyph = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '–'

  let body: string
  if (format === 'percent') {
    body = formatPercent(Math.abs(value), { digits: digits ?? 2 })
  } else if (format === 'currency') {
    body = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits ?? 2,
      maximumFractionDigits: digits ?? 2,
    }).format(Math.abs(value))
  } else {
    body = Math.abs(value).toFixed(digits ?? 2)
  }

  const sign = direction === 'up' ? '+' : direction === 'down' ? '−' : ''

  return (
    <span
      className={cn('inline-flex items-center gap-1 font-medium tabular', sizeClasses[size], className)}
      style={{ color }}
    >
      {!hideGlyph && (
        <span aria-hidden className="text-[0.85em] leading-none">
          {glyph}
        </span>
      )}
      {/* The sign is inside the accessible text, so a screen reader and a colorblind reader
          both get the direction without relying on the glyph or the color. */}
      <span>
        {sign}
        {body}
      </span>
    </span>
  )
}
