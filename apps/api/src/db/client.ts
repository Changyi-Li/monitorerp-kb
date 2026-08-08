import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type DB = PostgresJsDatabase<typeof schema>

export interface DbConnection {
  db: DB
  close: () => Promise<void>
}

export function createDb(databaseUrl: string): DbConnection {
  const client = postgres(databaseUrl)
  const db = drizzle(client, { schema })
  return { db, close: () => client.end() }
}
