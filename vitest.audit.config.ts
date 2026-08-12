import { defineConfig } from 'vitest/config'

/** Runs only the architecture completion audit (see *.audit.ts). */
export default defineConfig({
  test: {
    include: ['apps/**/*.audit.ts', 'packages/**/*.audit.ts'],
    environment: 'node',
  },
})
