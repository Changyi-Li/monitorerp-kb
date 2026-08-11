import { defineConfig } from 'vitest/config'

/**
 * The LIVE RagFlow suite configuration (release gate, spec #28 — stage (c)
 * revalidation and stage (a+) contract tests, tickets #35/#36) — entirely
 * separate from the daily suite (vitest.config.ts / `npm test`): opt-in and
 * env-gated, probes the REAL RagFlow instance. Runs via
 * `npm run gate:revalidation` / `npm run gate:contract`; fails loudly when
 * the RagFlow env vars are missing or the instance is unreachable (never a
 * silent skip).
 */
export default defineConfig({
  test: {
    environment: 'node',
    // `.live.ts` files only — the default suite's glob never matches them.
    include: ['test/live/**/*.live.ts'],
    // One live instance is shared; run files serially.
    fileParallelism: false,
    // A real completion stream against a real model needs generous timeouts
    // (spec #28, user story 13).
    testTimeout: 300_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/live/global-setup.ts'],
  },
})
