import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // The architecture audit (*.audit.ts) is a completion gate, not a unit
    // test: it fails while the transitional editor still exists. It runs via
    // `pnpm audit:editor` and folds into `pnpm test` once it is green.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.audit.ts'],
    environment: 'node',
  },
})
