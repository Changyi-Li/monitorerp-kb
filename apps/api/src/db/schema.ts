import { customType, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// citext — case-insensitive text. The extension is created in the migration
// (`CREATE EXTENSION IF NOT EXISTS "citext"`).
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext'
  },
})

export const roleEnum = pgEnum('role', ['member', 'super_admin'])
export const accountStatusEnum = pgEnum('account_status', ['active', 'pending', 'deactivated'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('member'),
  status: accountStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
