import postgres from 'postgres'

/**
 * Ensures the database named in `databaseUrl` exists on its Postgres server
 * (used by the test harness and the e2e stub server before the API migrates).
 */
export async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl)
  const dbName = url.pathname.slice(1)
  url.pathname = '/postgres'
  const bootstrap = postgres(url.toString(), { max: 1, onnotice: () => {} })
  const exists = await bootstrap`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
  if (exists.length === 0) {
    await bootstrap.unsafe(`CREATE DATABASE ${dbName}`)
  }
  await bootstrap.end()
}
