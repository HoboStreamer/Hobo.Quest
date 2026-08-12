import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The architecture audit runs with everything else now that it is green.
    // It was excluded while the transitional editor still existed; leaving
    // it out any longer would mean the normal test command deliberately
    // skipped architectural correctness.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.audit.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
})
