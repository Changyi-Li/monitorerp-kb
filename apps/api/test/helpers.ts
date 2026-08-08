import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import postgres from 'postgres'
import { createApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import type { DB } from '../src/db/client.js'
import { createDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_test'

export const TEST_CONFIG: Config = {
  databaseUrl: TEST_DATABASE_URL,
  jwtSecret: 'test-secret-not-for-production',
  adminEmail: 'admin@test.local',
  adminPassword: 'test-admin-password',
  adminName: 'Test Admin',
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
  const url = new URL(TEST_DATABASE_URL)
  const dbName = url.pathname.slice(1)
  url.pathname = '/postgres'
  const bootstrap = postgres(url.toString(), { max: 1, onnotice: () => {} })
  const exists = await bootstrap`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
  if (exists.length === 0) {
    await bootstrap.unsafe(`CREATE DATABASE ${dbName}`)
  }
  await bootstrap.end()
  const { db, close } = createDb(TEST_DATABASE_URL)
  await runMigrations(db)
  return { db, close }
}

export async function truncateAll(db: DB): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`)
}

export function makeApp(db: DB): Hono {
  return createApp({ db, config: TEST_CONFIG })
}
