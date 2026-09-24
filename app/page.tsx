import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Disclaimer } from '@/components/disclaimer'
import { MARKET_PULSE_SYMBOLS } from '@/lib/market/symbols'

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">quantEdge</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        Track your portfolio, understand its risk, and learn what the numbers actually mean.
      </p>

      {/* base-ui composes via a `render` prop rather than shadcn's older `asChild`. */}
      <div className="mt-8 flex flex-wrap gap-3">
        <Button size="lg" render={<Link href="/dashboard/ticker/AAPL" />}>
          Open a ticker
        </Button>
        {MARKET_PULSE_SYMBOLS.filter((s) => !s.startsWith('^')).map((symbol) => (
          <Button
            key={symbol}
            size="lg"
            variant="outline"
            render={<Link href={`/dashboard/ticker/${symbol}`} />}
          >
            {symbol}
          </Button>
        ))}
      </div>

      <div className="mt-12">
        <Disclaimer variant="modal" />
      </div>
    </main>
  )
}
