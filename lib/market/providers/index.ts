/**
 * Provider selection.
 *
 * Feature code must not import a concrete provider. It imports {@link getProvider} — or,
 * better, calls `lib/market/cache.ts`, which layers the database-backed bar cache on top.
 * Swapping to a paid provider later means adding one file here and changing one env var.
 */

import type { MarketDataProvider } from '@/lib/market/provider'
import { yahooProvider } from '@/lib/market/providers/yahoo'

export type ProviderName = 'yahoo'

const providers: Record<ProviderName, () => MarketDataProvider> = {
  yahoo: () => yahooProvider,
}

let cached: MarketDataProvider | null = null

/**
 * The active market-data provider.
 *
 * Selected by `MARKET_DATA_PROVIDER`, defaulting to Yahoo. An unknown value fails loudly
 * rather than silently falling back — a typo in production config should be a startup
 * error, not a mysterious change in where the data comes from.
 */
export function getProvider(): MarketDataProvider {
  if (cached) return cached

  const name = (process.env.MARKET_DATA_PROVIDER ?? 'yahoo') as ProviderName
  const factory = providers[name]
  if (!factory) {
    throw new Error(
      `Unknown MARKET_DATA_PROVIDER: ${JSON.stringify(name)}. Valid: ${Object.keys(providers).join(', ')}`,
    )
  }

  cached = factory()
  return cached
}

/** Test seam: force a provider (used by unit tests with a fake). */
export function __setProviderForTesting(provider: MarketDataProvider | null): void {
  cached = provider
}
