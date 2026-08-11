import { defineConfig } from '@playwright/test'
import { loadLiveEnv } from './e2e/live-env'

const E2E_DATABASE_URL = 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_e2e'

// Fails loudly at config load — before any server starts — when the four
// RagFlow env vars are missing: the gate talks to the REAL RagFlow instance,
// never the stub, and never silently skips (spec #28, user story 15).
const liveEnv = loadLiveEnv()

/**
 * The live RagFlow e2e configuration (stage (b) of the release gate, spec
 * #28 / ticket #37) — a separate configuration mirroring the daily e2e
 * harness: same web server pattern (the API against the e2e database, the
 * web dev server, the same-origin proxy), with the RagFlow stub server entry
 * replaced by the REAL instance via the standard env vars. The daily
 * configuration and `npm run test:e2e` are untouched; run this via
 * `npm run gate:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  // Only the live gate spec — the daily specs drive the stub and would fail
  // against the real instance. The `.live.ts` suffix keeps the daily config's
  // default glob from collecting it, so `npm run test:e2e` stays untouched.
  testMatch: 'ragflow-gate.live.ts',
  // A real parse and a real model stream take minutes, not seconds. The
  // per-stage budget bounds the worst case (5 tests × 300 s × one retry).
  timeout: 300_000,
  globalTimeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // One retry on infrastructure-style failures before the stage goes red.
  retries: 1,
  reporter: [['list']],
  globalSetup: './e2e/live-global-setup.ts',
  use: {
    baseURL: 'http://localhost:4800',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The API targets the REAL instance. The database bootstrap (ensure +
      // truncate — the daily stub server's clean-slate job) runs first, and a
      // fresh API is booted every run: reuseExistingServer false means a
      // stale stub-backed API on :4801 fails the run loudly instead of being
      // reused silently. Stop the daily e2e stack before running this.
      command: 'npx tsx e2e/boot-with-e2e-database.ts',
      url: 'http://127.0.0.1:4801/health',
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: '../api',
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        E2E_DATABASE_URL,
        JWT_SECRET: 'e2e-secret',
        ADMIN_EMAIL: 'admin@e2e.local',
        ADMIN_PASSWORD: 'admin-e2e-password',
        ADMIN_NAME: 'E2E Admin',
        RAGFLOW_URL: liveEnv.ragflowUrl,
        RAGFLOW_API_KEY: liveEnv.ragflowApiKey,
        RAGFLOW_DATASET_ID: liveEnv.ragflowDatasetId,
        RAGFLOW_AGENT_ID: liveEnv.ragflowAgentId,
        POLL_INTERVAL_MS: '1000',
        PORT: '4801',
      },
    },
    {
      // The web dev server proxies to whatever API is on :4801 — the fresh
      // one this run booted. Reuse is safe here and avoids a slow Next
      // rebuild.
      command: 'npx next dev -p 4800',
      url: 'http://localhost:4800/auth/sign-in',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
