/**
 * Compliance disclaimer.
 *
 * quantEdge is an analytics and education product. It does not provide personalized
 * investment advice, recommendations, or solicitations — and that distinction has to be
 * visible to the user, not merely true in the abstract.
 *
 * Where each variant belongs:
 * - `footer` — every authenticated page, persistently.
 * - `inline` — above and below the risk page, the Monte Carlo chart, the signals panel, the
 *   rebalance page, the position-size calculator, and every AI-generated card.
 * - `modal`  — first run, acknowledged into `users.disclaimer_ack_at`.
 * - `report` — header and footer of a shared public report.
 */

import { cn } from '@/lib/utils'

export const DISCLAIMER_TEXT =
  'quantEdge provides educational analytics based on market data you choose to track. ' +
  'It is not investment advice, not a recommendation to buy or sell any security, and not a ' +
  'solicitation. Market data may be delayed, incomplete, or inaccurate. Past performance does ' +
  'not indicate future results. Projections and simulations are hypothetical models, not ' +
  'forecasts. Consider consulting a licensed financial professional before making investment ' +
  'decisions.'

/** One-line form, for tight spaces where the full paragraph would crowd out the content. */
export const DISCLAIMER_SHORT =
  'Educational analytics, not investment advice. Data may be delayed.'

export type DisclaimerVariant = 'footer' | 'inline' | 'modal' | 'report'

export interface DisclaimerProps {
  variant?: DisclaimerVariant
  /**
   * Names the specific thing being qualified, e.g. "This projection is a hypothetical
   * model." A generic disclaimer is easy to tune out; a specific one is read.
   */
  context?: string
  className?: string
}

export function Disclaimer({ variant = 'footer', context, className }: DisclaimerProps) {
  if (variant === 'footer') {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>{DISCLAIMER_SHORT}</p>
    )
  }

  if (variant === 'inline') {
    return (
      <div
        className={cn(
          'rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground',
          className,
        )}
      >
        {context ? <span className="font-medium text-foreground">{context} </span> : null}
        {DISCLAIMER_SHORT}
      </div>
    )
  }

  // `modal` and `report` both show the full text — these are the moments where the user is
  // either agreeing to terms or sharing figures outside the app, so brevity is the wrong
  // trade.
  return (
    <div className={cn('space-y-2 text-xs text-muted-foreground', className)}>
      {context ? <p className="font-medium text-foreground">{context}</p> : null}
      <p>{DISCLAIMER_TEXT}</p>
    </div>
  )
}
