import postgres from 'postgres'
import { ensureDatabaseExists } from '../test/ensure-database.js'

/**
 * The live gate's (stage b, ticket #37) API bootstrap: performs the same
 * clean-slate the daily e2e's stub server does — ensure the e2e database
 * exists, truncate every table — then boots the real API in the SAME
 * process. One process means Playwright's webserver teardown kills the API
 * cleanly. Chained via the live Playwright config's webserver command.
 */
const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_e2e'

await ensureDatabaseExists(E2E_DATABASE_URL)

const sql = postgres(E2E_DATABASE_URL)
for (const table of ['document_history', 'documents', 'chat_sessions', 'users']) {
  const [known] = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`
  if (known !== undefined) {
    await sql.unsafe(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`)
  }
}
await sql.end()
console.log('[gate] e2e database ensured and truncated')

// Boot the API: migrations, super-admin seed, and the sweeper run from the
// same environment the webserver entry provides.
await import('../src/index.js')
