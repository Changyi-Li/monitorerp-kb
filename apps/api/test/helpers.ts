import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createConfiguredApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import type { DB } from '../src/db/client.js'
import { createDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { ensureDatabaseExists } from './ensure-database.js'

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_test'

export const TEST_CONFIG: Config = {
  databaseUrl: TEST_DATABASE_URL,
  jwtSecret: 'test-secret-not-for-production',
  adminEmail: 'admin@test.local',
  adminPassword: 'test-admin-password',
  adminName: 'Test Admin',
  ragflowUrl: 'http://127.0.0.1:1', // replaced per test suite by the RagFlow stub
  ragflowApiKey: 'stub-key',
  ragflowDatasetId: 'dev-dataset',
  pollIntervalMs: 0, // tests drive the sweeper explicitly
  port: 0,
}

export interface TestDatabase {
  db: DB
  close: () => Promise<void>
}

/**
 * Ensures the test database exists on the compose Postgres server, then
 * applies the committed migrations to it.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  await ensureDatabaseExists(TEST_DATABASE_URL)
  const { db, close } = createDb(TEST_DATABASE_URL)
  await runMigrations(db)
  return { db, close }
}

export async function truncateAll(db: DB): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`)
}

export function makeApp(db: DB, config: Config = TEST_CONFIG): Hono {
  return createConfiguredApp({ db, config })
}
