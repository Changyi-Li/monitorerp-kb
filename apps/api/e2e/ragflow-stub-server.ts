import postgres from 'postgres'
import { ensureDatabaseExists } from '../test/ensure-database.js'
import { startRagflowStub } from '../test/ragflow-stub.js'

const E2E_PORT = 9399
const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb_e2e'

await ensureDatabaseExists(E2E_DATABASE_URL)

// Clean slate for this run (a freshly created database has no tables yet —
// the API applies migrations and re-seeds the super admin on boot).
const sql = postgres(E2E_DATABASE_URL)
for (const table of ['document_history', 'documents', 'users']) {
  const [known] = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`
  if (known !== undefined) {
    await sql.unsafe(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`)
  }
}
await sql.end()

const stub = await startRagflowStub(E2E_PORT)
console.log(`RagFlow e2e stub listening on ${stub.url}`)
