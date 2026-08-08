import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import type { DB } from '../src/db/client.js'
import { seedSuperAdmin } from '../src/db/seed.js'
import { users } from '../src/db/schema.js'
import { createTestDatabase, makeApp, TEST_CONFIG, truncateAll, type TestDatabase } from './helpers.js'

let db: DB
let close: () => Promise<void>
let app: Hono

beforeAll(async () => {
  const created: TestDatabase = await createTestDatabase()
  db = created.db
  close = created.close
  app = makeApp(db)
})

afterAll(async () => {
  await close()
})

beforeEach(async () => {
  await truncateAll(db)
})

interface WireUser {
  id: string
  name: string
  email: string
  role: 'member' | 'super_admin'
  status: 'active' | 'pending' | 'deactivated'
  is_last_admin?: boolean
}

interface WireList {
  items: WireUser[]
  total: number
  page: number
  page_size: number
  counts: Record<string, number>
}

interface WireError {
  error: { code: string; message: string; fields?: Record<string, string[]> }
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const value = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  if (value === undefined) throw new Error(`sign-in failed for ${email}`)
  return value
}

const cookieHeader = (cookie: string): { cookie: string } => ({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` })

/** Seeds the super admin from test config and returns their session cookie. */
async function adminCookie(): Promise<string> {
  await seedSuperAdmin(db, {
    email: TEST_CONFIG.adminEmail,
    password: TEST_CONFIG.adminPassword,
    name: TEST_CONFIG.adminName,
  })
  return await signIn(TEST_CONFIG.adminEmail, TEST_CONFIG.adminPassword)
}

/** Creates an active member directly and returns their session cookie. */
async function memberCookie(): Promise<string> {
  await signUp('member@example.com')
  await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
  return await signIn('member@example.com', 'correct-horse')
}

async function signUp(email: string): Promise<void> {
  const res = await app.request('/auth/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: email.split('@')[0], email, password: 'correct-horse' }),
  })
  expect(res.status).toBe(201)
}

async function patchUser(cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return await app.request(`/users/${id}`, {
    method: 'PATCH',
    headers: { ...cookieHeader(cookie), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function findUserId(email: string): Promise<string> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (row === undefined) throw new Error(`user ${email} missing`)
  return row.id
}

describe('GET /users', () => {
  it('lists users with pagination shape and is_last_admin flags', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    await signUp('pending@example.com')

    const res = await app.request('/users', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    const body = await jsonOf<WireList>(res)
    expect(body).toMatchObject({ total: 3, page: 1, page_size: 20 })
    expect(body.counts).toEqual({ active: 2, pending: 1, deactivated: 0 })
    const byEmail = new Map(body.items.map((u) => [u.email, u]))
    expect(byEmail.get(TEST_CONFIG.adminEmail)).toMatchObject({ role: 'super_admin', status: 'active', is_last_admin: true })
    expect(byEmail.get('member@example.com')).toMatchObject({ role: 'member', status: 'active', is_last_admin: false })
    expect(byEmail.get('pending@example.com')).toMatchObject({ role: 'member', status: 'pending', is_last_admin: false })
  })

  it('filters by status and role, and paginates', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    await signUp('pending@example.com')
    await signUp('member2@example.com')
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.email, 'member2@example.com'))

    const active = await jsonOf<WireList>(await app.request('/users?status=active', { headers: cookieHeader(cookie) }))
    expect(active.total).toBe(2)
    const admins = await jsonOf<WireList>(await app.request('/users?role=super_admin', { headers: cookieHeader(cookie) }))
    expect(admins.total).toBe(1)
    const page1 = await jsonOf<WireList>(await app.request('/users?page=1&page_size=2', { headers: cookieHeader(cookie) }))
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(4)
    const page2 = await jsonOf<WireList>(await app.request('/users?page=2&page_size=2', { headers: cookieHeader(cookie) }))
    expect(page2.items).toHaveLength(2)
  })

  it('forbids members', async () => {
    const cookie = await memberCookie()
    const res = await app.request('/users', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(403)
    expect((await jsonOf<WireError>(res)).error.code).toBe('forbidden')
  })

  it('requires a session', async () => {
    const res = await app.request('/users')
    expect(res.status).toBe(401)
  })

  it('validates query params', async () => {
    const cookie = await adminCookie()
    const res = await app.request('/users?status=banana', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /users/:id', () => {
  it('promotes a member to super admin and demotes back', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    const id = await findUserId('member@example.com')

    const promoted = await patchUser(cookie, id, { role: 'super_admin' })
    expect(promoted.status).toBe(200)
    expect((await jsonOf<{ user: WireUser }>(promoted)).user.role).toBe('super_admin')

    const demoted = await patchUser(cookie, id, { role: 'member' })
    expect(demoted.status).toBe(200)
    expect((await jsonOf<{ user: WireUser }>(demoted)).user.role).toBe('member')
  })

  it('deactivates and reactivates', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    const id = await findUserId('member@example.com')

    const deactivated = await patchUser(cookie, id, { status: 'deactivated' })
    expect(deactivated.status).toBe(200)
    expect((await jsonOf<{ user: WireUser }>(deactivated)).user.status).toBe('deactivated')

    const reactivated = await patchUser(cookie, id, { status: 'active' })
    expect(reactivated.status).toBe(200)
    expect((await jsonOf<{ user: WireUser }>(reactivated)).user.status).toBe('active')
  })

  it('activates a pending account; pending can only be activated', async () => {
    const cookie = await adminCookie()
    await signUp('pending@example.com')
    const id = await findUserId('pending@example.com')

    const activated = await patchUser(cookie, id, { status: 'active' })
    expect(activated.status).toBe(200)
    expect((await jsonOf<{ user: WireUser }>(activated)).user.status).toBe('active')

    await signUp('other-pending@example.com')
    const otherId = await findUserId('other-pending@example.com')
    const deactivated = await patchUser(cookie, otherId, { status: 'deactivated' })
    expect(deactivated.status).toBe(409)
    expect((await jsonOf<WireError>(deactivated)).error.code).toBe('wrong_status')
  })

  it('does not allow a role change on a pending account', async () => {
    const cookie = await adminCookie()
    await signUp('pending@example.com')
    const id = await findUserId('pending@example.com')
    const res = await patchUser(cookie, id, { role: 'super_admin' })
    expect(res.status).toBe(409)
    expect((await jsonOf<WireError>(res)).error.code).toBe('wrong_status')
  })

  it('cannot set a user back to pending', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    const id = await findUserId('member@example.com')
    const res = await patchUser(cookie, id, { status: 'pending' })
    expect(res.status).toBe(409)
    expect((await jsonOf<WireError>(res)).error.code).toBe('wrong_status')
  })

  it('protects the last active super admin from demotion and deactivation (409 last_admin)', async () => {
    const cookie = await adminCookie()
    const adminId = await findUserId(TEST_CONFIG.adminEmail)

    const demote = await patchUser(cookie, adminId, { role: 'member' })
    expect(demote.status).toBe(409)
    expect((await jsonOf<WireError>(demote)).error.code).toBe('last_admin')

    const deactivate = await patchUser(cookie, adminId, { status: 'deactivated' })
    expect(deactivate.status).toBe(409)
    expect((await jsonOf<WireError>(deactivate)).error.code).toBe('last_admin')
  })

  it('allows demoting a super admin once another active super admin exists', async () => {
    const cookie = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    const memberId = await findUserId('member@example.com')
    await patchUser(cookie, memberId, { role: 'super_admin' })

    const adminId = await findUserId(TEST_CONFIG.adminEmail)
    const res = await patchUser(cookie, adminId, { role: 'member' })
    expect(res.status).toBe(200)
  })

  it('deactivation takes effect immediately: existing session dies, sign-in is refused', async () => {
    const admin = await adminCookie()
    await signUp('member@example.com')
    await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
    const member = await signIn('member@example.com', 'correct-horse')
    await expect(app.request('/auth/me', { headers: cookieHeader(member) })).resolves.toMatchObject({ status: 200 })

    const id = await findUserId('member@example.com')
    await patchUser(admin, id, { status: 'deactivated' })

    const me = await app.request('/auth/me', { headers: cookieHeader(member) })
    expect(me.status).toBe(401)
    const signInRes = await app.request('/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correct-horse' }),
    })
    expect(signInRes.status).toBe(403)
  })

  it('rejects an empty patch and a malformed body', async () => {
    const cookie = await adminCookie()
    const id = await findUserId(TEST_CONFIG.adminEmail)
    const empty = await patchUser(cookie, id, {})
    expect(empty.status).toBe(400)
    const malformed = await patchUser(cookie, id, { role: 'banana' })
    expect(malformed.status).toBe(400)
    expect((await jsonOf<WireError>(malformed)).error.code).toBe('validation_error')
  })

  it('returns 404 for unknown and non-uuid ids; 403 and 401 for callers', async () => {
    const cookie = await adminCookie()
    const missing = await patchUser(cookie, '00000000-0000-0000-0000-000000000000', { role: 'member' })
    expect(missing.status).toBe(404)
    const notUuid = await patchUser(cookie, 'not-a-uuid', { role: 'member' })
    expect(notUuid.status).toBe(404)

    const member = await memberCookie()
    const id = await findUserId(TEST_CONFIG.adminEmail)
    const forbidden = await patchUser(member, id, { role: 'member' })
    expect(forbidden.status).toBe(403)

    const unauth = await app.request(`/users/${id}`, { method: 'PATCH', body: '{}' })
    expect(unauth.status).toBe(401)
  })
})

describe('no user deletion in v1', () => {
  it('answers 404 on DELETE /users/:id', async () => {
    const cookie = await adminCookie()
    const id = await findUserId(TEST_CONFIG.adminEmail)
    const res = await app.request(`/users/${id}`, { method: 'DELETE', headers: cookieHeader(cookie) })
    expect(res.status).toBe(404)
  })
})
