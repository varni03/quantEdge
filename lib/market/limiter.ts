/**
 * Rate limiting and request de-duplication for outbound provider calls.
 *
 * The free data tier is the binding constraint on this whole app. A dashboard showing 30
 * positions can trivially fan out to hundreds of requests per page load, get throttled, and
 * then render a page full of dashes. Two mechanisms prevent that, and they solve different
 * problems:
 *
 * - **Token bucket** caps the *rate* of requests leaving the process.
 * - **In-flight de-duplication** collapses *concurrent identical* requests into one. Ten
 *   components asking for AAPL during a single render produce one upstream call, not ten.
 *   This matters far more than it sounds: React Server Components render concurrently, so
 *   duplicate demand is the normal case rather than the exception.
 *
 * Note the scope limit: this is per-process, in-memory state. On a serverless platform each
 * instance has its own bucket, so this is a good-citizen measure rather than a hard global
 * guarantee. The durable protection against rate limits is the database-backed bar cache in
 * `cache.ts` — steady state, a dashboard load makes zero bar requests. This module protects
 * the cold path.
 */

export interface LimiterOptions {
  /** Maximum requests allowed to start concurrently. */
  concurrency?: number
  /** Minimum spacing between request starts, in milliseconds. */
  minGapMs?: number
  /** Burst capacity — how many requests may go out immediately after an idle period. */
  burst?: number
}

const DEFAULTS: Required<LimiterOptions> = {
  concurrency: 4,
  minGapMs: 250,
  burst: 6,
}

interface QueueEntry {
  run: () => void
}

/**
 * A token-bucket limiter with a concurrency ceiling.
 *
 * Tokens accrue at `1 / minGapMs` and cap at `burst`, so a quiet period earns a small burst
 * allowance while sustained load settles to the steady rate.
 */
export class RateLimiter {
  private readonly concurrency: number
  private readonly minGapMs: number
  private readonly burst: number

  private tokens: number
  private lastRefill: number
  private active = 0
  private queue: QueueEntry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Total requests admitted since construction — surfaced in dev to catch fan-out regressions. */
  private admitted = 0

  constructor(opts: LimiterOptions = {}) {
    const { concurrency, minGapMs, burst } = { ...DEFAULTS, ...opts }
    this.concurrency = concurrency
    this.minGapMs = minGapMs
    this.burst = burst
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  get stats(): { admitted: number; queued: number; active: number } {
    return { admitted: this.admitted, queued: this.queue.length, active: this.active }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    const earned = elapsed / this.minGapMs
    if (earned <= 0) return
    this.tokens = Math.min(this.burst, this.tokens + earned)
    this.lastRefill = now
  }

  /** Wrap a task so it only starts when the limiter permits. */
  async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    this.active++
    this.admitted++
    try {
      return await task()
    } finally {
      this.active--
      this.drain()
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ run: resolve })
      this.drain()
    })
  }

  private drain(): void {
    this.refill()

    while (this.queue.length > 0 && this.active < this.concurrency && this.tokens >= 1) {
      this.tokens -= 1
      const entry = this.queue.shift()!
      entry.run()
    }

    // Something is still waiting: wake up when the next token is due.
    if (this.queue.length > 0 && this.timer === null) {
      const deficit = Math.max(0, 1 - this.tokens)
      const waitMs = Math.max(10, Math.ceil(deficit * this.minGapMs))
      this.timer = setTimeout(() => {
        this.timer = null
        this.drain()
      }, waitMs)
      // Don't hold a serverless function or test runner open on this timer.
      this.timer.unref?.()
    }
  }
}

/**
 * Collapses concurrent identical requests into a single upstream call.
 *
 * Only *in-flight* promises are tracked — this is not a result cache and deliberately
 * retains nothing once settled. Caching lives in `cache.ts`, where it can be reasoned about
 * with real TTLs and persistence; conflating the two here would produce a cache with
 * invisible, accidental lifetime.
 */
export class InFlightMap {
  private readonly map = new Map<string, Promise<unknown>>()

  /** Number of calls that were served by joining an existing request. */
  private coalesced = 0

  get stats(): { inFlight: number; coalesced: number } {
    return { inFlight: this.map.size, coalesced: this.coalesced }
  }

  async dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key)
    if (existing) {
      this.coalesced++
      return existing as Promise<T>
    }

    const promise = task().finally(() => {
      this.map.delete(key)
    })
    this.map.set(key, promise)
    return promise
  }
}

/**
 * Retry with exponential backoff, but only for errors worth retrying.
 *
 * `shouldRetry` decides; the default policy retries rate limits and transient
 * unavailability and gives up immediately on a bad symbol, since no amount of retrying will
 * conjure a ticker that doesn't exist. A provider-supplied `retryAfterMs` always wins over
 * the computed backoff.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  opts: {
    attempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    shouldRetry?: (err: unknown) => boolean
    retryAfterMs?: (err: unknown) => number | undefined
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 8_000
  const shouldRetry = opts.shouldRetry ?? (() => true)

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task()
    } catch (err) {
      lastError = err
      if (attempt === attempts || !shouldRetry(err)) throw err

      const hinted = opts.retryAfterMs?.(err)
      // Full jitter, to avoid a thundering herd when several callers back off together.
      const backoff = Math.min(max, base * 2 ** (attempt - 1))
      const delay = hinted ?? Math.round(backoff * (0.5 + Math.random() * 0.5))

      opts.onRetry?.(err, attempt, delay)
      await sleep(delay)
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/** Split a list into fixed-size chunks — used to respect `maxSymbolsPerQuoteCall`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Process-wide singletons.
 *
 * Module-level state survives across requests within a warm serverless instance, which is
 * exactly the lifetime we want: long enough to coalesce a render's worth of duplicate
 * demand, short enough that nothing goes stale.
 */
export const providerLimiter = new RateLimiter()
export const providerInFlight = new InFlightMap()
