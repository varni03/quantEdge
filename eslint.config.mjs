import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),

  {
    /**
     * The provider seam, enforced mechanically.
     *
     * `yahoo-finance2` talks to an unofficial API with no stability guarantee, so it will
     * eventually break or need replacing with a paid provider. That stays a one-file change
     * only if nothing else in the codebase imports it directly — and a convention nobody can
     * violate by accident is worth far more than one written in a comment.
     *
     * The single legal importer is `lib/market/providers/yahoo.ts`, exempted below.
     */
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'yahoo-finance2',
              message:
                'Import market data through lib/market/cache.ts (or lib/market/providers). ' +
                'Only lib/market/providers/yahoo.ts may import yahoo-finance2 directly — that ' +
                'is what keeps swapping providers a one-file change.',
            },
          ],
          patterns: [
            {
              group: ['yahoo-finance2/*'],
              message:
                'Import market data through lib/market/cache.ts (or lib/market/providers). ' +
                'Only lib/market/providers/yahoo.ts may import yahoo-finance2 directly.',
            },
          ],
        },
      ],
    },
  },
  {
    // The one sanctioned importer.
    files: ['lib/market/providers/yahoo.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
])

export default eslintConfig
