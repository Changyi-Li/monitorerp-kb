import { defineConfig } from '@playwright/test'

const API_DIR = '../api'
const E2E_DATABASE_URL = 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_e2e'

/**
 * Full-stack e2e: the web app (dev server) proxying to the real API, backed
 * by the compose Postgres (e2e database) and the in-process RagFlow stub on
 * a fixed port. No live RagFlow is involved.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The RagFlow stub must be up before the API, which targets it.
      command: 'npx tsx e2e/ragflow-stub-server.ts',
      url: 'http://127.0.0.1:9399/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      cwd: API_DIR,
      env: { E2E_DATABASE_URL },
    },
    {
      command: 'npx tsx src/index.ts',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      cwd: API_DIR,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        JWT_SECRET: 'e2e-secret',
        ADMIN_EMAIL: 'admin@e2e.local',
        ADMIN_PASSWORD: 'admin-e2e-password',
        ADMIN_NAME: 'E2E Admin',
        RAGFLOW_URL: 'http://127.0.0.1:9399',
        RAGFLOW_API_KEY: 'stub-key',
        RAGFLOW_DATASET_ID: 'e2e-dataset',
        POLL_INTERVAL_MS: '1000',
        PORT: '3001',
      },
    },
    {
      command: 'npx next dev -p 3000',
      url: 'http://localhost:3000/auth/sign-in',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
})
