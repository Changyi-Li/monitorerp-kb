import { sql } from 'drizzle-orm'
import { hashPassword } from '../auth/passwords.js'
import type { DB } from './client.js'
import { users } from './schema.js'

export interface AdminSeedConfig {
  email: string
  password: string
  name: string
}

/**
 * Seeds the first super admin from environment configuration when the users
 * table is empty. Returns true when a row was inserted (callers log that once);
 * returns false on any subsequent boot.
 */
export async function seedSuperAdmin(db: DB, admin: AdminSeedConfig): Promise<boolean> {
  const [row] = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM users`)
  if (row === undefined || row.count > 0) return false
  await db.insert(users).values({
    name: admin.name,
    email: admin.email,
    passwordHash: await hashPassword(admin.password),
    role: 'super_admin',
    status: 'active',
  })
  return true
}
