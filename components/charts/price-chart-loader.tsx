'use client'

/**
 * Client-side loader for {@link PriceChart}.
 *
 * This wrapper exists for one specific reason: `lightweight-charts` needs a DOM canvas and
 * must not server-render, but Next 16's docs are explicit that `ssr: false` "is not supported
 * in Server Components — you will see an error if you try to use it." So the dynamic import
 * has to live inside a Client Component, which is this file.
 *
 * It also owns the indicator toggles, which keeps the ticker page a Server Component that
 * just fetches data and hands it over as serializable props.
 */

import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import type { ChartBar, ChartOverlay } from '@/components/charts/price-chart'

const PriceChart = dynamic(() => import('@/components/charts/price-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[420px] w-full" />,
})

/**
 * An overlay the server has already computed.
 *
 * The indicator math runs server-side in `lib/quant`, so the client receives plain numbers.
 * That keeps a single implementation of every indicator — one that unit tests can reach —
 * rather than a second copy in the browser that could silently disagree.
 */
export interface OverlaySpec extends ChartOverlay {
  /** Whether the overlay starts visible. */
  defaultOn?: boolean
}

export interface PriceChartLoaderProps {
  bars: ChartBar[]
  overlays: OverlaySpec[]
  height?: number
}

export default function PriceChartLoader({ bars, overlays, height }: PriceChartLoaderProps) {
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(overlays.filter((o) => o.defaultOn !== false).map((o) => o.id)),
  )

  const active = useMemo(
    () => overlays.filter((o) => enabled.has(o.id)),
    [overlays, enabled],
  )

  function toggle(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      {/* Toggles double as the legend — required whenever two or more series are drawn, so
          identity never rests on color alone. Each row pairs a color chip with its name. */}
      {overlays.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {overlays.map((o) => {
            const on = enabled.has(o.id)
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                aria-pressed={on}
                className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                style={{ opacity: on ? 1 : 0.45 }}
              >
                <span
                  aria-hidden
                  className="inline-block h-0.5 w-4 rounded-full"
                  style={{ backgroundColor: `var(${o.colorVar})` }}
                />
                <span>{o.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <PriceChart bars={bars} overlays={active} height={height} showVolume />
    </div>
  )
}
