import { SignJWT } from 'jose'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '../src/auth/jwt.js'
import { verifyPassword } from '../src/auth/passwords.js'
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

const VALID_SIGNUP = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse' }

interface UserResponse {
  id: string
  name: string
  email: string
  role: string
  status: string
}

interface ErrorResponse {
  error: { code: string; message: string; fields?: Record<string, string[]> }
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function signUp(overrides: Record<string, unknown> = {}): Promise<Response> {
  return await postJson('/auth/sign-up', { ...VALID_SIGNUP, ...overrides })
}

/** Reads the `kb_session` value out of a Set-Cookie header. */
function sessionCookieValue(setCookie: string): string {
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  const value = match?.[1]
  if (value === undefined) throw new Error('kb_session cookie missing from Set-Cookie header')
  return value
}

async function getWithCookie(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } })
}

/** Creates an active user directly in the DB and returns their email + password. */
async function createActiveUser(): Promise<{ email: string; password: string }> {
  await signUp({ email: 'member@example.com' })
  await db.update(users).set({ status: 'active' }).where(eq(users.email, 'member@example.com'))
  return { email: 'member@example.com', password: VALID_SIGNUP.password }
}

/** Creates an active, passwordless (OIDC-provisioned) user directly in the DB. */
async function createPasswordlessUser(): Promise<void> {
  await db.insert(users).values({
    name: 'OIDC User',
    email: 'oidc@example.com',
    passwordHash: null,
    role: 'member',
    status: 'active',
  })
}

describe('POST /auth/sign-up', () => {
  it('creates a pending member account (201) with a hashed password', async () => {
    const res = await signUp()
    expect(res.status).toBe(201)
    const body = await jsonOf<{ user: UserResponse }>(res)
    expect(body.user).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'member',
      status: 'pending',
    })
    expect(body.user.id).toBeTypeOf('string')
    expect('password_hash' in body.user).toBe(false)

    const [stored] = await db.select().from(users).where(eq(users.email, 'ada@example.com')).limit(1)
    expect(stored?.status).toBe('pending')
    expect(stored?.role).toBe('member')
    expect(stored?.passwordHash).not.toBe(VALID_SIGNUP.password)
    if (stored === undefined) throw new Error('user row missing')
    if (stored.passwordHash === null) throw new Error('user row missing password hash')
    await expect(verifyPassword(VALID_SIGNUP.password, stored.passwordHash)).resolves.toBe(true)
  })

  it('rejects invalid input with 400 validation_error and fields', async () => {
    const cases: Array<Record<string, unknown>> = [
      { name: '', email: 'ada@example.com', password: 'correct-horse' },
      { name: 'Ada', email: 'not-an-email', password: 'correct-horse' },
      { name: 'Ada', email: 'ada@example.com', password: 'short' },
    ]
    for (const body of cases) {
      const res = await postJson('/auth/sign-up', body)
      expect(res.status).toBe(400)
      const { error } = await jsonOf<ErrorResponse>(res)
      expect(error.code).toBe('validation_error')
      expect(error.fields).toBeDefined()
      expect(Object.keys(error.fields ?? {}).length).toBeGreaterThan(0)
    }
  })

  it('rejects a duplicate email with 409 duplicate_email, case-insensitively', async () => {
    expect((await signUp()).status).toBe(201)
    const exact = await signUp()
    expect(exact.status).toBe(409)
    expect((await jsonOf<ErrorResponse>(exact)).error.code).toBe('duplicate_email')
    const differentCase = await signUp({ email: 'ADA@example.com' })
    expect(differentCase.status).toBe(409)
  })
})

describe('POST /auth/sign-in', () => {
  it('returns 401 for unknown email and wrong password', async () => {
    await signUp()
    const unknown = await postJson('/auth/sign-in', { email: 'ghost@example.com', password: 'correct-horse' })
    expect(unknown.status).toBe(401)
    expect((await jsonOf<ErrorResponse>(unknown)).error.code).toBe('unauthorized')
    const wrong = await postJson('/auth/sign-in', { email: 'ada@example.com', password: 'wrong-password' })
    expect(wrong.status).toBe(401)
  })

  it('returns 401 invalid-credentials (never a server error) for an account without a password', async () => {
    // An OIDC-provisioned account (issue #59): no password hash, active.
    await createPasswordlessUser()
    const res = await postJson('/auth/sign-in', { email: 'oidc@example.com', password: 'any-password' })
    expect(res.status).toBe(401)
    expect((await jsonOf<ErrorResponse>(res)).error.code).toBe('unauthorized')
  })

  it('returns 401 for a passwordless account regardless of the password supplied', async () => {
    await createPasswordlessUser()
    for (const password of ['wrong-password', 'correct-horse', VALID_SIGNUP.password]) {
      const res = await postJson('/auth/sign-in', { email: 'oidc@example.com', password })
      expect(res.status).toBe(401)
    }
  })

  it('returns 403 for a pending account', async () => {
    await signUp()
    const res = await postJson('/auth/sign-in', { email: 'ada@example.com', password: 'correct-horse' })
    expect(res.status).toBe(403)
    const { error } = await jsonOf<ErrorResponse>(res)
    expect(error.code).toBe('forbidden')
    expect(error.message.toLowerCase()).toContain('activation')
  })

  it('returns 403 for a deactivated account', async () => {
    await signUp()
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.email, 'ada@example.com'))
    const res = await postJson('/auth/sign-in', { email: 'ada@example.com', password: 'correct-horse' })
    expect(res.status).toBe(403)
    const { error } = await jsonOf<ErrorResponse>(res)
    expect(error.code).toBe('forbidden')
    expect(error.message.toLowerCase()).toContain('deactivated')
  })

  it('sets the kb_session cookie (httpOnly, SameSite=Lax, path=/, 7-day, no Secure) for an active user', async () => {
    await createActiveUser()
    const res = await postJson('/auth/sign-in', { email: 'member@example.com', password: VALID_SIGNUP.password })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ user: UserResponse }>(res)
    expect(body.user).toMatchObject({ email: 'member@example.com', role: 'member', status: 'active' })

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    const cookie = setCookie ?? ''
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[^;]+`))
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`)
    expect(cookie).not.toContain('Secure')
  })
})

describe('GET /auth/me', () => {
  it('returns 401 without a session', async () => {
    const res = await app.request('/auth/me')
    expect(res.status).toBe(401)
    expect((await jsonOf<ErrorResponse>(res)).error.code).toBe('unauthorized')
  })

  it('returns 401 for a garbage cookie', async () => {
    const res = await getWithCookie('/auth/me', 'not-a-jwt')
    expect(res.status).toBe(401)
  })

  it('returns 401 (not 500) for a malformed cookie value', async () => {
    const res = await app.request('/auth/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=%zz` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-0000-0000-000000000000')
      .setIssuedAt(now - 8 * 86400)
      .setExpirationTime(now - 86400)
      .sign(new TextEncoder().encode(TEST_CONFIG.jwtSecret))
    const res = await getWithCookie('/auth/me', expired)
    expect(res.status).toBe(401)
  })

  it('returns the current user with role and status', async () => {
    await createActiveUser()
    const signIn = await postJson('/auth/sign-in', { email: 'member@example.com', password: VALID_SIGNUP.password })
    const cookie = sessionCookieValue(signIn.headers.get('set-cookie') ?? '')
    const res = await getWithCookie('/auth/me', cookie)
    expect(res.status).toBe(200)
    const body = await jsonOf<{ user: UserResponse }>(res)
    expect(body.user).toMatchObject({ email: 'member@example.com', role: 'member', status: 'active' })
    expect('password_hash' in body.user).toBe(false)
  })

  it('deactivation takes effect immediately: an existing session stops working', async () => {
    await createActiveUser()
    const signIn = await postJson('/auth/sign-in', { email: 'member@example.com', password: VALID_SIGNUP.password })
    const cookie = sessionCookieValue(signIn.headers.get('set-cookie') ?? '')
    await expect(getWithCookie('/auth/me', cookie)).resolves.toMatchObject({ status: 200 })

    await db.update(users).set({ status: 'deactivated' }).where(eq(users.email, 'member@example.com'))
    const res = await getWithCookie('/auth/me', cookie)
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/sign-out', () => {
  it('clears the cookie (204)', async () => {
    await createActiveUser()
    const signIn = await postJson('/auth/sign-in', { email: 'member@example.com', password: VALID_SIGNUP.password })
    const cookie = sessionCookieValue(signIn.headers.get('set-cookie') ?? '')

    const res = await app.request('/auth/sign-out', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    })
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`))
    expect(setCookie).toContain('Max-Age=0')
  })

  it('returns 401 when not signed in', async () => {
    const res = await app.request('/auth/sign-out', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('seedSuperAdmin', () => {
  it('seeds an activated super admin on an empty table and returns true only on first boot', async () => {
    const seeded = await seedSuperAdmin(db, {
      email: TEST_CONFIG.adminEmail,
      password: TEST_CONFIG.adminPassword,
      name: TEST_CONFIG.adminName,
    })
    expect(seeded).toBe(true)
    const [row] = await db.select().from(users).where(eq(users.email, TEST_CONFIG.adminEmail)).limit(1)
    expect(row).toMatchObject({ role: 'super_admin', status: 'active', name: 'Test Admin' })

    const again = await seedSuperAdmin(db, {
      email: TEST_CONFIG.adminEmail,
      password: TEST_CONFIG.adminPassword,
      name: TEST_CONFIG.adminName,
    })
    expect(again).toBe(false)
    const all = await db.select({ count: users.id }).from(users)
    expect(all.length).toBe(1)
  })

  it('the seeded admin can sign in', async () => {
    await seedSuperAdmin(db, {
      email: TEST_CONFIG.adminEmail,
      password: TEST_CONFIG.adminPassword,
      name: TEST_CONFIG.adminName,
    })
    const res = await postJson('/auth/sign-in', {
      email: TEST_CONFIG.adminEmail,
      password: TEST_CONFIG.adminPassword,
    })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ user: UserResponse }>(res)
    expect(body.user).toMatchObject({ role: 'super_admin', status: 'active' })
    expect(body.user.email).toBe(TEST_CONFIG.adminEmail)
  })
})

describe('error envelope', () => {
  it('wraps unknown routes in the envelope (404)', async () => {
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await jsonOf<ErrorResponse>(res)).toEqual({ error: { code: 'not_found', message: 'Not found' } })
  })
})
