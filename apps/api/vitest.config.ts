import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // One real Postgres server is shared by the test suite; run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
