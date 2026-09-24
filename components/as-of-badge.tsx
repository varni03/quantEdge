/**
 * Market-state and data-freshness badge.
 *
 * Free market data is delayed, and after the close it stops moving entirely. The failure mode
 * this component prevents is a stale price presented as if it were live — a user glancing at
 * a dashboard on Sunday should not think they're seeing Sunday's prices, and a "day change"
 * from Friday must be labelled as Friday's.
 *
 * So the badge always states the market state, and when closed it names the session the data
 * actually came from rather than just going quiet.
 */

import { cn } from '@/lib/utils'
import type { MarketState } from '@/lib/market/calendar'

export interface AsOfBadgeProps {
  state: MarketState
  /** Human-readable status, e.g. "Closed · as of Fri Jul 24". */
  label: string
  /** Epoch ms the underlying value was current, for the tooltip. */
  asOf?: number
  className?: string
}

/**
 * Each state gets a distinct glyph as well as a distinct color, so the four states are
 * separable without color vision.
 */
const stateStyle: Record<MarketState, { glyph: string; color: string; srLabel: string }> = {
  REGULAR: { glyph: '●', color: 'var(--status-good)', srLabel: 'Market open' },
  PRE: { glyph: '◐', color: 'var(--status-warning)', srLabel: 'Pre-market' },
  POST: { glyph: '◑', color: 'var(--status-warning)', srLabel: 'After hours' },
  CLOSED: { glyph: '○', color: 'var(--neutral-delta)', srLabel: 'Market closed' },
}

export function AsOfBadge({ state, label, asOf, className }: AsOfBadgeProps) {
  const style = stateStyle[state]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
        className,
      )}
      title={asOf ? `Data as of ${new Date(asOf).toLocaleString()}` : undefined}
    >
      <span aria-hidden style={{ color: style.color }} className="leading-none">
        {style.glyph}
      </span>
      <span className="sr-only">{style.srLabel}. </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}
