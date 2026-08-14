import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import type { DB } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { createTestDatabase, makeApp, TEST_CONFIG, truncateAll, type TestDatabase } from './helpers.js'
import { startRagflowStub, type RagflowStub } from './ragflow-stub.js'

// The dataset display-name endpoint (issue #40): the web shell reads the
// RagFlow dataset name through this route instead of baking a NEXT_PUBLIC
// variable into the client bundle. Contract: session-gated, `{name}` on
// success, 502 upstream_error when RagFlow cannot answer.

let db: DB
let close: () => Promise<void>
let app: Hono
let stub: RagflowStub

beforeAll(async () => {
  const created: TestDatabase = await createTestDatabase()
  db = created.db
  close = created.close
  stub = await startRagflowStub()
  app = makeApp(db, { ...TEST_CONFIG, ragflowUrl: stub.url })
})

afterAll(async () => {
  await stub.close()
  await close()
})

beforeEach(async () => {
  await truncateAll(db)
  stub.failDatasets = false
})

const USER = { email: 'member@example.com', password: 'correct-horse' }

/** Creates an active member directly and returns a session cookie. */
async function memberCookie(): Promise<string> {
  await app.request('/auth/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace', email: USER.email, password: USER.password }),
  })
  await db.update(users).set({ status: 'active' }).where(eq(users.email, USER.email))
  const res = await app.request('/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(USER),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const value = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  if (value === undefined) throw new Error('sign-in failed: no session cookie')
  return value
}

describe('GET /dataset', () => {
  it('answers 401 without a session', async () => {
    const res = await app.request('/dataset')
    expect(res.status).toBe(401)
  })

  it('returns the RagFlow dataset display name', async () => {
    stub.datasetName = 'Stub Knowledge Dataset'
    const cookie = await memberCookie()
    const res = await app.request('/dataset', { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Stub Knowledge Dataset' })
  })

  it('maps a RagFlow failure to 502 upstream_error', async () => {
    stub.failDatasets = true
    const cookie = await memberCookie()
    const res = await app.request('/dataset', { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_error' } })
  })
})
