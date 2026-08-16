import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { createTestDatabase, truncateAll, type TestDatabase } from './helpers.js'

let db: DB
let close: () => Promise<void>

beforeAll(async () => {
  const created: TestDatabase = await createTestDatabase()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

beforeEach(async () => {
  await truncateAll(db)
})

let emailCounter = 0

async function insertUser(overrides: Record<string, unknown> = {}): Promise<void> {
  emailCounter += 1
  await db.insert(users).values({
    name: 'OIDC User',
    email: `oidc-${emailCounter}@example.com`,
    passwordHash: null,
    role: 'member',
    status: 'active',
    ...overrides,
  })
}

const ISSUER = 'https://idp.example/realms/monitorerp'

describe('identity link schema (issue #59)', () => {
  it('a user row may have no password and no identity link', async () => {
    await insertUser({ email: 'plain-oidc@example.com' })
    const [row] = await db.select().from(users).where(eq(users.email, 'plain-oidc@example.com')).limit(1)
    expect(row?.passwordHash).toBeNull()
    expect(row?.issuer).toBeNull()
    expect(row?.subject).toBeNull()
  })

  it('a user row may carry an identity link (issuer + subject)', async () => {
    await insertUser({ email: 'linked@example.com', issuer: ISSUER, subject: 'sub-1' })
    const [row] = await db.select().from(users).where(eq(users.email, 'linked@example.com')).limit(1)
    expect(row?.issuer).toBe(ISSUER)
    expect(row?.subject).toBe('sub-1')
  })

  it('the (issuer, subject) pair is unique — a second row with the same pair is rejected', async () => {
    await insertUser({ issuer: ISSUER, subject: 'sub-1' })
    await expect(
      db.insert(users).values({
        name: 'Other User',
        email: 'other@example.com',
        passwordHash: null,
        issuer: ISSUER,
        subject: 'sub-1',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('the same subject under a different issuer is allowed (multi-issuer future-proofing)', async () => {
    await insertUser({ issuer: 'https://idp.example/realms/a', subject: 'sub-1' })
    await insertUser({ issuer: 'https://idp.example/realms/b', subject: 'sub-1' })
    const rows = await db.select().from(users)
    expect(rows).toHaveLength(2)
  })

  it('many rows without an identity link coexist (NULLs stay distinct in the unique index)', async () => {
    await insertUser({})
    await insertUser({})
    await insertUser({})
    const rows = await db.select().from(users)
    expect(rows).toHaveLength(3)
  })

  it('a password account can also hold an identity link (both doors, one account)', async () => {
    await insertUser({
      email: 'both@example.com',
      passwordHash: 'some-hash',
      issuer: ISSUER,
      subject: 'sub-2',
    })
    const [row] = await db.select().from(users).where(eq(users.email, 'both@example.com')).limit(1)
    expect(row?.passwordHash).toBe('some-hash')
    expect(row?.issuer).toBe(ISSUER)
    expect(row?.subject).toBe('sub-2')
  })
})
