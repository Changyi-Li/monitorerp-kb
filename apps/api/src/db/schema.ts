import { sql } from 'drizzle-orm'
import {
  bigint,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// citext — case-insensitive text. The extension is created in the migration
// (`CREATE EXTENSION IF NOT EXISTS "citext"`).
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext'
  },
})

export const roleEnum = pgEnum('role', ['member', 'super_admin'])
export const accountStatusEnum = pgEnum('account_status', ['active', 'pending', 'deactivated'])
export const documentStatusEnum = pgEnum('document_status', [
  'draft',
  'publishing',
  'published',
  'failed',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: citext('email').notNull().unique(),
    // Nullable: OIDC-provisioned accounts (issue #59) have no password —
    // the identity provider vouches for them. Password sign-in against
    // such an account fails with the standard invalid-credentials response.
    passwordHash: text('password_hash'),
    role: roleEnum('role').notNull().default('member'),
    status: accountStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // OIDC identity link — keyed by the provider's stable subject, never by
    // email, so an email change in the identity provider cannot break the
    // link. Null for password-only accounts; unique per provider.
    issuer: text('issuer'),
    subject: text('subject'),
  },
  (t) => [uniqueIndex('users_issuer_subject_unique').on(t.issuer, t.subject)],
)

// Size is stored as bigint (mode number) so multi-hundred-MB uploads are
// exact; a 1 GiB cap is the app's own limit.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ext: text('ext').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    ragflowDocumentId: text('ragflow_document_id').notNull().unique(),
    chunkMethod: text('chunk_method').notNull().default('naive'),
    status: documentStatusEnum('status').notNull().default('draft'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    retryCount: integer('retry_count').notNull().default(0),
    progress: integer('progress').notNull().default(0),
    lastError: text('last_error'),
    chunkCount: integer('chunk_count').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('documents_owner_id_idx').on(t.ownerId),
    index('documents_status_idx').on(t.status),
    index('documents_updated_at_idx').on(sql`${t.updatedAt} desc`),
  ],
)

// Metadata only — messages are never stored; history is fetched live from
// RagFlow on demand (chatbot spec #23).
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    ragflowSessionId: text('ragflow_session_id').notNull().unique(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_sessions_owner_id_idx').on(t.ownerId),
    index('chat_sessions_owner_updated_idx').on(t.ownerId, sql`${t.updatedAt} desc`),
  ],
)

export const documentHistory = pgTable(
  'document_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Nullable: sweeper (system) transitions have no acting user.
    actorId: uuid('actor_id').references(() => users.id),
    fromStatus: documentStatusEnum('from_status'),
    toStatus: documentStatusEnum('to_status').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('document_history_document_id_idx').on(t.documentId)],
)
