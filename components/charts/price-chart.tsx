'use client'

/**
 * Candlestick price chart with a volume pane and indicator overlays.
 *
 * Built on TradingView's `lightweight-charts`, which is imperative and canvas-based. Three
 * rules make that coexist with React instead of fighting it:
 *
 * 1. **Never a controlled component.** The chart is created once in an effect and fed data
 *    imperatively via `setData`. Trying to re-create it on every prop change produces
 *    flicker, leaks canvases, and loses the user's pan/zoom position.
 * 2. **Theme is bridged, not duplicated.** Colors are read from the same CSS custom
 *    properties the rest of the app uses, at mount and on theme change. A canvas can't
 *    inherit CSS, so this is the only way the chart stays in the design system rather than
 *    drifting into its own hardcoded palette.
 * 3. **Client-only.** Canvas needs a DOM, so this file is `'use client'` and is loaded
 *    through a client-side dynamic import with `ssr: false` (see `price-chart-loader.tsx`).
 *    Next 16 rejects `ssr: false` inside a Server Component, so the loader must itself be a
 *    Client Component.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts'

/**
 * One bar, pre-serialized for the client boundary.
 *
 * `time` is a `yyyy-MM-dd` session date rather than a timestamp — deliberately. It's what
 * `lightweight-charts` calls a business day, it matches the app's session-date convention
 * and the Postgres `date` column, and it removes timezone from the rendering path entirely.
 * A viewer in Hong Kong and one in New York see the same bar on the same day.
 */
export interface ChartBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** A line drawn over the price pane — a moving average, a band edge. */
export interface ChartOverlay {
  /** Stable identity for the series. Color follows this, never the array position. */
  id: string
  label: string
  /** `null` for the indicator's warm-up window; those points are simply not drawn. */
  values: (number | null)[]
  /** A CSS custom property name, e.g. `--series-1`. Resolved against the live theme. */
  colorVar: string
  lineWidth?: 1 | 2 | 3
  /** Dashed lines read as "projected"; reserve for genuinely hypothetical series. */
  dashed?: boolean
}

export interface PriceChartProps {
  bars: ChartBar[]
  overlays?: ChartOverlay[]
  /** Renders a separate volume pane beneath the price pane. */
  showVolume?: boolean
  height?: number
  className?: string
}

/** Resolve a CSS custom property to a concrete color against a live element. */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

interface Theme {
  candleUp: string
  candleDown: string
  candleUpWick: string
  candleDownWick: string
  volumeUp: string
  volumeDown: string
  grid: string
  axis: string
  inkMuted: string
  crosshair: string
  text: string
}

function readTheme(el: HTMLElement): Theme {
  return {
    candleUp: cssVar(el, '--candle-up', '#0ca30c'),
    candleDown: cssVar(el, '--candle-down', '#d03b3b'),
    candleUpWick: cssVar(el, '--candle-up-wick', '#0a8a0a'),
    candleDownWick: cssVar(el, '--candle-down-wick', '#b33232'),
    volumeUp: cssVar(el, '--volume-up', 'rgba(12,163,12,0.35)'),
    volumeDown: cssVar(el, '--volume-down', 'rgba(208,59,59,0.35)'),
    grid: cssVar(el, '--viz-grid', '#e1e0d9'),
    axis: cssVar(el, '--viz-axis', '#c3c2b7'),
    inkMuted: cssVar(el, '--viz-ink-muted', '#898781'),
    crosshair: cssVar(el, '--viz-crosshair', 'rgba(11,11,11,0.35)'),
    // The chart's own text uses the app's foreground ink, never a series color.
    text: cssVar(el, '--color-foreground', '#0b0b0b'),
  }
}

interface HoverPoint {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  changePct: number | null
  /**
   * Overlay swatches carry the CSS variable *name*, not a resolved color. The canvas has to
   * resolve variables in JS because it can't inherit CSS — but this readout is ordinary DOM,
   * so letting CSS resolve `var(--series-1)` keeps it correct through a theme change with no
   * JS involved, and avoids reading a ref during render.
   */
  overlays: { label: string; value: number; colorVar: string }[]
}

export default function PriceChart({
  bars,
  overlays = [],
  showVolume = true,
  height = 420,
  className,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const overlayRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())

  const [hover, setHover] = useState<HoverPoint | null>(null)
  /** Bumped when the theme changes, to force a re-read of the CSS variables. */
  const [themeEpoch, setThemeEpoch] = useState(0)

  /** Index bars by date so crosshair events can find the full bar in O(1). */
  const barsByTime = useMemo(() => {
    const m = new Map<string, { bar: ChartBar; index: number }>()
    bars.forEach((bar, index) => m.set(bar.time, { bar, index }))
    return m
  }, [bars])

  // ── watch for theme changes ───────────────────────────────────────────────
  // next-themes toggles a `dark` class on <html>, which a canvas cannot observe. A
  // MutationObserver on the class attribute is how the chart learns to restyle itself.
  useEffect(() => {
    const target = document.documentElement
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1))
    observer.observe(target, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  // ── create the chart once ─────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const theme = readTheme(container)

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: theme.inkMuted,
        fontFamily:
          getComputedStyle(container).fontFamily ||
          'system-ui, -apple-system, "Segoe UI", sans-serif',
        attributionLogo: false,
        panes: { separatorColor: theme.grid, separatorHoverColor: theme.axis },
      },
      grid: {
        // Solid hairlines only. Dashed gridlines add noise and read as "projected".
        vertLines: { color: theme.grid, style: LineStyle.Solid, visible: true },
        horzLines: { color: theme.grid, style: LineStyle.Solid, visible: true },
      },
      rightPriceScale: {
        borderColor: theme.axis,
        scaleMargins: { top: 0.08, bottom: showVolume ? 0.08 : 0.08 },
      },
      timeScale: {
        borderColor: theme.axis,
        // Daily bars: show the date, not a time-of-day that doesn't exist.
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        // Magnet snaps the horizontal line to the close, so the readout matches a real value
        // rather than wherever the pointer happens to sit.
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: theme.axis,
        },
        horzLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: theme.axis,
        },
      },
      handleScroll: true,
      handleScale: true,
    })

    chartRef.current = chart

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: theme.candleUp,
      downColor: theme.candleDown,
      wickUpColor: theme.candleUpWick,
      wickDownColor: theme.candleDownWick,
      // No border: drawing outlines around marks to separate them adds weight without
      // adding information, and at low zoom the borders swallow the bodies.
      borderVisible: false,
    })
    candleRef.current = candles

    if (showVolume) {
      const volumePane = chart.addPane()
      const volume = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
        chart.panes().indexOf(volumePane),
      )
      volumeRef.current = volume
      // Volume is context, not the subject — give it a quarter of the height.
      volumePane.setHeight(Math.round(height * 0.22))
    }

    // Captured now, so cleanup doesn't read a ref that may have been reassigned by then.
    const overlaySeries = overlayRefs.current

    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      overlaySeries.clear()
    }
    // Recreating on `height`/`showVolume` change is correct — those alter the pane layout.
  }, [height, showVolume])

  // ── restyle on theme change ───────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    const chart = chartRef.current
    if (!container || !chart) return

    const theme = readTheme(container)

    chart.applyOptions({
      layout: {
        textColor: theme.inkMuted,
        panes: { separatorColor: theme.grid, separatorHoverColor: theme.axis },
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.axis },
      timeScale: { borderColor: theme.axis },
      crosshair: {
        vertLine: { color: theme.crosshair, labelBackgroundColor: theme.axis },
        horzLine: { color: theme.crosshair, labelBackgroundColor: theme.axis },
      },
    })

    candleRef.current?.applyOptions({
      upColor: theme.candleUp,
      downColor: theme.candleDown,
      wickUpColor: theme.candleUpWick,
      wickDownColor: theme.candleDownWick,
    })

    for (const overlay of overlays) {
      overlayRefs.current
        .get(overlay.id)
        ?.applyOptions({ color: cssVar(container, overlay.colorVar, '#2a78d6') })
    }
  }, [themeEpoch, overlays])

  // ── feed price + volume data ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    const candles = candleRef.current
    if (!container || !candles) return

    candles.setData(
      bars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )

    const volume = volumeRef.current
    if (volume) {
      const theme = readTheme(container)
      volume.setData(
        bars.map((b, i) => ({
          time: b.time,
          value: b.volume,
          // Volume inherits the day's direction so the two panes read as one story.
          color: i > 0 && b.close < bars[i - 1].close ? theme.volumeDown : theme.volumeUp,
        })),
      )
    }

    chartRef.current?.timeScale().fitContent()
  }, [bars, themeEpoch])

  // ── feed overlay series ───────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    const chart = chartRef.current
    if (!container || !chart) return

    const live = new Set(overlays.map((o) => o.id))

    // Remove overlays that have been toggled off.
    for (const [id, series] of overlayRefs.current) {
      if (!live.has(id)) {
        chart.removeSeries(series)
        overlayRefs.current.delete(id)
      }
    }

    for (const overlay of overlays) {
      let series = overlayRefs.current.get(overlay.id)
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: cssVar(container, overlay.colorVar, '#2a78d6'),
          lineWidth: overlay.lineWidth ?? 2,
          lineStyle: overlay.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
        overlayRefs.current.set(overlay.id, series)
      }

      // Drop the warm-up nulls rather than plotting them as zero, which would drag the
      // price axis to the origin and make the candles unreadable.
      series.setData(
        overlay.values
          .map((v, i) => (v === null || bars[i] === undefined ? null : { time: bars[i].time, value: v }))
          .filter((d): d is { time: string; value: number } => d !== null),
      )
    }
  }, [overlays, bars, themeEpoch])

  // ── crosshair readout ─────────────────────────────────────────────────────
  // The dataviz guidance is that a tooltip must never be the only way to read a value, so
  // this supplements the always-visible header stats rather than replacing them.
  useEffect(() => {
    const chart = chartRef.current
    const container = containerRef.current
    if (!chart || !container) return

    const handler = (param: MouseEventParams) => {
      if (!param.time || param.point === undefined) {
        setHover(null)
        return
      }

      const time = String(param.time)
      const entry = barsByTime.get(time)
      if (!entry) {
        setHover(null)
        return
      }

      const { bar, index } = entry
      const prev = index > 0 ? bars[index - 1] : null
      const changePct = prev && prev.close !== 0 ? (bar.close / prev.close - 1) * 100 : null

      setHover({
        time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        changePct,
        overlays: overlays
          .map((o) => {
            const v = o.values[index]
            return v === null || v === undefined
              ? null
              : { label: o.label, value: v, colorVar: o.colorVar }
          })
          .filter((x): x is { label: string; value: number; colorVar: string } => x !== null),
      })
    }

    chart.subscribeCrosshairMove(handler)
    return () => chart.unsubscribeCrosshairMove(handler)
  }, [barsByTime, bars, overlays])

  const latest = hover ?? lastBarAsHover(bars, overlays)

  return (
    <div className={className}>
      {/* Readout sits above the plot and is always populated — from the crosshair when
          hovering, otherwise from the most recent bar. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs tabular">
        {latest ? (
          <>
            <span className="text-muted-foreground">{latest.time}</span>
            <Readout label="O" value={latest.open} />
            <Readout label="H" value={latest.high} />
            <Readout label="L" value={latest.low} />
            <Readout label="C" value={latest.close} emphasis />
            {latest.changePct !== null && (
              <span
                className="font-medium"
                style={{
                  color:
                    latest.changePct > 0
                      ? 'var(--gain)'
                      : latest.changePct < 0
                        ? 'var(--loss)'
                        : 'var(--neutral-delta)',
                }}
              >
                {/* Sign and arrow, so direction never depends on color alone. */}
                {latest.changePct > 0 ? '▲ +' : latest.changePct < 0 ? '▼ ' : ''}
                {latest.changePct.toFixed(2)}%
              </span>
            )}
            <span className="text-muted-foreground">
              Vol {formatVolume(latest.volume)}
            </span>
            {latest.overlays.map((o) => (
              <span key={o.label} className="flex items-center gap-1.5">
                {/* A color chip carries identity; the text stays in ink tokens. */}
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: `var(${o.colorVar})` }}
                />
                <span className="text-muted-foreground">{o.label}</span>
                <span className="text-foreground">{o.value.toFixed(2)}</span>
              </span>
            ))}
          </>
        ) : (
          <span className="text-muted-foreground">No price data</span>
        )}
      </div>

      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  )
}

function Readout({
  label,
  value,
  emphasis,
}: {
  label: string
  value: number
  emphasis?: boolean
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={emphasis ? 'font-medium text-foreground' : 'text-foreground'}>
        {value.toFixed(2)}
      </span>
    </span>
  )
}

/** Fallback readout when the pointer isn't over the plot: the most recent bar. */
function lastBarAsHover(bars: ChartBar[], overlays: ChartOverlay[]): HoverPoint | null {
  if (bars.length === 0) return null
  const i = bars.length - 1
  const bar = bars[i]
  const prev = i > 0 ? bars[i - 1] : null

  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    changePct: prev && prev.close !== 0 ? (bar.close / prev.close - 1) * 100 : null,
    overlays: overlays
      .map((o) => {
        const v = o.values[i]
        return v === null || v === undefined
          ? null
          : { label: o.label, value: v, colorVar: o.colorVar }
      })
      .filter((x): x is { label: string; value: number; colorVar: string } => x !== null),
  }
}

function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return String(v)
}

export type { UTCTimestamp }
