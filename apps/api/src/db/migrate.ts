import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { DB } from './client.js'

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url))

export function runMigrations(db: DB): Promise<void> {
  return migrate(db, { migrationsFolder })
}
