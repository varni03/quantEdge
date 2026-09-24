import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * `yahoo-finance2` is an ESM package that manages its own HTTP client, cookie jar and
   * request queue. Bundling it into the server build interferes with that machinery, so it's
   * marked external and loaded through native `require` instead.
   *
   * `postgres` (postgres-js) deliberately isn't listed — it's pure JavaScript with no native
   * bindings and bundles cleanly.
   */
  serverExternalPackages: ['yahoo-finance2'],

  /**
   * Deliberately NOT enabling `cacheComponents` / `use cache` yet.
   *
   * On a serverless deployment `use cache` entries live in an in-memory LRU that does not
   * persist across requests, so it would do nothing for the problem we actually have — a
   * hard third-party rate limit. Correctness here comes from the database-backed bar cache
   * in `lib/market/cache.ts`, where the lifetime is explicit and inspectable.
   *
   * Enabling it also removes the `dynamic` / `revalidate` route-segment config, adds Suspense
   * requirements, and introduces prerender-time failures around short cache lifetimes — a
   * poor trade while the app is still taking shape. Revisit purely as a latency optimization
   * once the data layer has settled.
   */
}

export default nextConfig
