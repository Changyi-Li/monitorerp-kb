import { defineConfig } from '@playwright/test'
import { loadOidcLiveEnv } from './e2e/oidc-live-env'

const E2E_DATABASE_URL = 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_e2e'

// Fails loudly at config load — before any server starts — when the four
// OIDC vars are missing: the gate drives the real round trip against the
// development Keycloak, never a mock, and never silently skips (spec #57).
// The values also feed the API boot below.
const oidcEnv = loadOidcLiveEnv()

/**
 * The live OIDC e2e configuration (spec #57 / issue #62) — a separate
 * configuration mirroring the daily e2e harness: same web server pattern
 * (the RagFlow stub, the API against the e2e database, the web dev server,
 * the same-origin proxy), with the four OIDC variables set so the API's
 * capability endpoint reports enabled and the flow endpoints are live. The
 * daily configuration and `npm run test:e2e` are untouched; run this via
 * `npm run gate:oidc`.
 */
export default defineConfig({
  testDir: './e2e',
  // Only the live OIDC gate spec — the `.live.ts` suffix keeps it out of the
  // daily config's default glob.
  testMatch: 'oidc-gate.live.ts',
  timeout: 120_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // One retry on infrastructure-style failures before the gate goes red.
  retries: 1,
  reporter: [['list']],
  globalSetup: './e2e/oidc-live-global-setup.ts',
  use: {
    baseURL: 'http://localhost:4800',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The RagFlow stub (as in the daily harness) so the signed-in landing
      // renders normally — RagFlow itself is out of scope for this gate.
      command: 'npx tsx e2e/ragflow-stub-server.ts',
      url: 'http://127.0.0.1:9399/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      cwd: '../api',
      env: { E2E_DATABASE_URL },
    },
    {
      // A fresh API booted every run with OIDC enabled: reuseExistingServer
      // false means a stale unconfigured API on :4801 fails the run loudly
      // instead of being reused silently. Stop the daily e2e stack before
      // running this (both configurations own ports 4800/4801).
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
        RAGFLOW_URL: 'http://127.0.0.1:9399',
        RAGFLOW_API_KEY: 'stub-key',
        RAGFLOW_DATASET_ID: 'e2e-dataset',
        RAGFLOW_AGENT_ID: 'e2e-agent',
        POLL_INTERVAL_MS: '1000',
        PORT: '4801',
        OIDC_ISSUER_URL: oidcEnv.issuerUrl,
        OIDC_CLIENT_ID: oidcEnv.clientId,
        OIDC_CLIENT_SECRET: oidcEnv.clientSecret,
        OIDC_REDIRECT_URI: oidcEnv.redirectUri,
      },
    },
    {
      // The web dev server proxies to whatever API is on :4801 — the fresh
      // OIDC-enabled one this run booted. Reuse is safe here and avoids a
      // slow Next rebuild.
      command: 'npx next dev -p 4800',
      url: 'http://localhost:4800/auth/sign-in',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
