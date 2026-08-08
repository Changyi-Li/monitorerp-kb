import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { seedSuperAdmin } from './db/seed.js'

try {
  process.loadEnvFile()
} catch {
  // .env is optional — deployments supply the environment directly.
}

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)

await runMigrations(db)
const seeded = await seedSuperAdmin(db, {
  email: config.adminEmail,
  password: config.adminPassword,
  name: config.adminName,
})
if (seeded) console.log(`Seeded super admin ${config.adminEmail}`)

const app = createApp({ db, config })
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`monitorerp-api listening on :${info.port}`)
})

const shutdown = (): void => {
  void close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
