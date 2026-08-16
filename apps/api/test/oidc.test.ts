import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import { hashPassword } from '../src/auth/passwords.js'
import { loadConfig, OIDC_VARIABLES, type Config } from '../src/config.js'
import type { DB } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { FLOW_COOKIE_NAME } from '../src/routes/oidc.js'
import { createTestDatabase, makeApp, TEST_CONFIG, truncateAll, type TestDatabase } from './helpers.js'
import {
  OIDC_STUB_CLIENT_ID,
  OIDC_STUB_CLIENT_SECRET,
  startOidcStub,
  type OidcStub,
  type OidcStubDefects,
} from './oidc-stub.js'

type OidcVarName = (typeof OIDC_VARIABLES)[number]

const OIDC_ENV: Record<OidcVarName, string> = {
  OIDC_ISSUER_URL: 'http://127.0.0.1:8081/realms/monitorerp',
  OIDC_CLIENT_ID: 'monitorerp-kb',
  OIDC_CLIENT_SECRET: 'dev-client-secret',
  OIDC_REDIRECT_URI: 'http://localhost:4800/api/auth/oidc/callback',
}

/** A complete env with every required variable; OIDC variables are layered on. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://monitorerp:monitorerp@localhost:5433/monitorerp_kb',
    JWT_SECRET: 'test-secret',
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD: 'test-admin-password',
    RAGFLOW_URL: 'http://ragflow.test',
    RAGFLOW_API_KEY: 'key',
    RAGFLOW_DATASET_ID: 'dataset',
    RAGFLOW_AGENT_ID: 'agent',
    ...overrides,
  }
}

function oidcEnv(...names: OidcVarName[]): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const name of names) env[name] = OIDC_ENV[name]
  return baseEnv(env)
}

/** The error message loadConfig throws for the given env ('' when it does not throw). */
function loadConfigError(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

describe('loadConfig — OIDC configuration (issue #58)', () => {
  it('with no OIDC variables set, boots normally with OIDC disabled', () => {
    const config = loadConfig(baseEnv())
    expect(config.oidc).toBeNull()
  })

  it('with any one of the four variables set, fails with a clear configuration error', () => {
    for (const name of OIDC_VARIABLES) {
      const message = loadConfigError(oidcEnv(name))
      expect(message).toContain('OIDC')
      expect(message).toContain('OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI')
      expect(message).toContain(name)
    }
  })

  it('with any proper subset of the four variables set, fails with a clear configuration error', () => {
    const triples: OidcVarName[][] = [
      ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'],
      ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'],
      ['OIDC_ISSUER_URL', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'],
      ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'],
    ]
    for (const names of triples) {
      const message = loadConfigError(oidcEnv(...names))
      expect(message).toContain('OIDC')
      expect(message).toContain('OIDC_REDIRECT_URI')
    }
  })

  it('treats an empty variable as unset, so a full set with one empty is a configuration error', () => {
    const env = oidcEnv(...OIDC_VARIABLES)
    env['OIDC_CLIENT_SECRET'] = ''
    expect(() => loadConfig(env)).toThrow(/OIDC/)
  })

  it('with all four variables set, exposes the OIDC configuration with the derived login URL', () => {
    const config = loadConfig(oidcEnv(...OIDC_VARIABLES))
    expect(config.oidc).toEqual({
      issuerUrl: 'http://127.0.0.1:8081/realms/monitorerp',
      clientId: 'monitorerp-kb',
      clientSecret: 'dev-client-secret',
      redirectUri: 'http://localhost:4800/api/auth/oidc/callback',
      // The web button's URL: the redirect URI with the fixed callback
      // suffix replaced by the login path.
      loginUrl: 'http://localhost:4800/api/auth/oidc/login',
    })
  })

  it('rejects a redirect URI that does not end with the fixed callback path', () => {
    const env = oidcEnv(...OIDC_VARIABLES)
    env['OIDC_REDIRECT_URI'] = 'http://localhost:4800/somewhere-else'
    const message = loadConfigError(env)
    expect(message).toContain('OIDC_REDIRECT_URI')
    expect(message).toContain('/auth/oidc/callback')
  })
})

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

describe('GET /auth/oidc/* — capability and inert endpoints (issue #58)', () => {
  it('with OIDC disabled, the capability endpoint reports {enabled: false}', async () => {
    const app: Hono = makeApp(db, TEST_CONFIG)
    const res = await app.request('/auth/oidc/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })

  it('with OIDC disabled, the login and callback endpoints are inert (404, as before OIDC)', async () => {
    const app: Hono = makeApp(db, TEST_CONFIG)
    for (const path of ['/auth/oidc/login', '/auth/oidc/callback']) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })
    }
  })

  it('with all four variables set, the capability endpoint reports enabled with the login URL', async () => {
    const app: Hono = makeApp(db, {
      ...TEST_CONFIG,
      oidc: {
        issuerUrl: 'http://127.0.0.1:8081/realms/monitorerp',
        clientId: 'monitorerp-kb',
        clientSecret: 'dev-client-secret',
        redirectUri: 'http://localhost:4800/api/auth/oidc/callback',
        loginUrl: 'http://localhost:4800/api/auth/oidc/login',
      },
    })
    const res = await app.request('/auth/oidc/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true, loginUrl: 'http://localhost:4800/api/auth/oidc/login' })
  })
})

// ─── The sign-in flow (issue #61) ───────────────────────────────────────────

/** Extracts one cookie's value from a (possibly joined) Set-Cookie header. */
function cookieValue(setCookie: string, name: string): string | null {
  const match = setCookie.match(new RegExp(`(?:^|, )${name}=([^;,]*)`))
  return match?.[1] ?? null
}

interface FlowArtifacts {
  authUrl: string
  state: string
  nonce: string
  flowCookie: string
  setCookie: string
}

/** Runs the login endpoint and returns what the browser would hold. */
async function beginFlow(app: Hono): Promise<FlowArtifacts> {
  const res = await app.request('/auth/oidc/login')
  expect(res.status).toBe(302)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const authUrl = new URL(res.headers.get('location') ?? '')
  const state = authUrl.searchParams.get('state')
  const nonce = authUrl.searchParams.get('nonce')
  const flowCookie = cookieValue(setCookie, FLOW_COOKIE_NAME)
  expect(state).not.toBeNull()
  expect(nonce).not.toBeNull()
  expect(flowCookie).not.toBeNull()
  return {
    authUrl: authUrl.toString(),
    state: state as string,
    nonce: nonce as string,
    flowCookie: flowCookie as string,
    setCookie,
  }
}

/** Plays the mock provider's authorize step, then hits the callback with the code. */
async function finishFlow(app: Hono, flow: FlowArtifacts): Promise<Response> {
  const authRes = await fetch(flow.authUrl, { redirect: 'manual' })
  expect(authRes.status).toBe(302)
  const callbackUrl = new URL(authRes.headers.get('location') ?? '')
  const code = callbackUrl.searchParams.get('code')
  expect(code).not.toBeNull()
  return await app.request(`/auth/oidc/callback?code=${encodeURIComponent(code as string)}&state=${encodeURIComponent(flow.state)}`, {
    headers: { cookie: `${FLOW_COOKIE_NAME}=${flow.flowCookie}` },
  })
}

/** The current user through the session cookie, exactly as the app sees it. */
async function currentUser(app: Hono, sessionValue: string): Promise<{ id: string; email: string; role: string; status: string }> {
  const res = await app.request('/auth/me', { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionValue}` } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { user: { id: string; email: string; role: string; status: string } }
  return body.user
}

describe('GET /auth/oidc/login + /auth/oidc/callback — the sign-in flow (issue #61)', () => {
  let stub: OidcStub
  let flowApp: Hono
  let oidcConfig: NonNullable<Config['oidc']>

  beforeAll(async () => {
    stub = await startOidcStub()
    oidcConfig = {
      issuerUrl: stub.url,
      clientId: OIDC_STUB_CLIENT_ID,
      clientSecret: OIDC_STUB_CLIENT_SECRET,
      redirectUri: 'http://localhost:4800/api/auth/oidc/callback',
      loginUrl: 'http://localhost:4800/api/auth/oidc/login',
    }
    flowApp = makeApp(db, { ...TEST_CONFIG, oidc: oidcConfig })
  })

  afterAll(async () => {
    await stub.close()
  })

  beforeEach(() => {
    stub.setUser({
      subject: 'stub-subject-1',
      email: 'alice@example.com',
      name: 'Alice Example',
      givenName: 'Alice',
      familyName: 'Example',
      preferredUsername: 'alice',
    })
    stub.setDefects({})
    stub.setDiscoveryIssuer(stub.url)
  })

  it('full round trip: login redirect, mock authorize, callback, session, active passwordless Member row', async () => {
    const flow = await beginFlow(flowApp)

    // The login redirect carries the authorization-code + PKCE request.
    const authUrl = new URL(flow.authUrl)
    expect(authUrl.origin + authUrl.pathname).toBe(`${stub.url}/protocol/openid-connect/auth`)
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('client_id')).toBe(OIDC_STUB_CLIENT_ID)
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:4800/api/auth/oidc/callback')
    expect(authUrl.searchParams.get('scope')).toBe('openid email profile')
    expect(authUrl.searchParams.get('state')).toBe(flow.state)
    expect(authUrl.searchParams.get('nonce')).toBe(flow.nonce)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    const challenge = authUrl.searchParams.get('code_challenge')
    expect(challenge).not.toBeNull()

    // The flow cookie is short-lived, HttpOnly, SameSite=Lax, and holds the
    // PKCE verifier — only the challenge ever leaves the API.
    expect(flow.setCookie).toContain('HttpOnly')
    expect(flow.setCookie).toContain('SameSite=Lax')
    expect(flow.setCookie).toContain('Max-Age=600')
    const stored = JSON.parse(Buffer.from(flow.flowCookie, 'base64url').toString('utf8')) as {
      state?: unknown
      nonce?: unknown
      verifier?: unknown
    }
    expect(stored.state).toBe(flow.state)
    expect(stored.nonce).toBe(flow.nonce)
    expect(typeof stored.verifier).toBe('string')
    expect(createHash('sha256').update(stored.verifier as string).digest('base64url')).toBe(challenge)

    // Mock authorize → callback with the code.
    const res = await finishFlow(flowApp, flow)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800')
    const setCookie = res.headers.get('set-cookie') ?? ''
    const sessionValue = cookieValue(setCookie, SESSION_COOKIE_NAME)
    expect(sessionValue).not.toBeNull()
    // The flow cookie is cleared.
    expect(cookieValue(setCookie, FLOW_COOKIE_NAME)).toBe('')
    expect(setCookie).toContain('Max-Age=0')

    // The token exchange carried the PKCE verifier and the client secret.
    expect(stub.tokenRequests[0]?.codeVerifier).toBe(stored.verifier)
    expect(stub.tokenRequests[0]?.clientSecret).toBe(OIDC_STUB_CLIENT_SECRET)

    // The session cookie is the same one password sign-in issues: it works
    // against /auth/me.
    const me = await currentUser(flowApp, sessionValue as string)
    expect(me).toMatchObject({ email: 'alice@example.com', role: 'member', status: 'active' })

    // The user row: active Member, no password, identity columns populated.
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row).toMatchObject({
      name: 'Alice Example',
      email: 'alice@example.com',
      role: 'member',
      status: 'active',
      passwordHash: null,
      issuer: stub.url,
      subject: 'stub-subject-1',
    })
  })

  it('a returning User signs in to the same account', async () => {
    const first = await finishFlow(flowApp, await beginFlow(flowApp))
    const firstUser = await currentUser(flowApp, cookieValue(first.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME) as string)

    const second = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(second.status).toBe(302)
    const secondUser = await currentUser(flowApp, cookieValue(second.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME) as string)

    expect(secondUser.id).toBe(firstUser.id)
    expect(await db.select().from(users)).toHaveLength(1)
  })

  it('auto-links by email to an existing password User; the password door still works', async () => {
    await db.insert(users).values({
      name: 'Ada Lovelace',
      email: 'alice@example.com',
      passwordHash: await hashPassword('correct-horse'),
      role: 'member',
      status: 'active',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800')

    // One User, both doors: linked, no second row.
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.issuer).toBe(stub.url)
    expect(row?.subject).toBe('stub-subject-1')
    expect(row?.passwordHash).not.toBeNull()
    expect(row?.status).toBe('active')
    expect(await db.select().from(users)).toHaveLength(1)

    // The password door still works on the same account.
    const signIn = await flowApp.request('/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse' }),
    })
    expect(signIn.status).toBe(200)
  })

  it('refuses when the matching email already holds a different OIDC identity', async () => {
    await db.insert(users).values({
      name: 'Bob',
      email: 'alice@example.com',
      passwordHash: null,
      role: 'member',
      status: 'active',
      issuer: 'https://other-idp.example/realms/other',
      subject: 'bob-subject',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(cookieValue(setCookie, SESSION_COOKIE_NAME)).toBeNull()
    expect(cookieValue(setCookie, FLOW_COOKIE_NAME)).toBe('')

    // The row is untouched — the different identity was never taken over.
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.issuer).toBe('https://other-idp.example/realms/other')
    expect(row?.subject).toBe('bob-subject')
  })

  const VALIDATION_FAILURES: Array<[string, Partial<OidcStubDefects>]> = [
    ['bad signature', { badSignature: true }],
    ['wrong issuer', { wrongIssuer: true }],
    ['wrong audience', { wrongAudience: true }],
    ['missing nonce', { missingNonce: true }],
    ['wrong nonce', { wrongNonce: true }],
    ['expired', { expired: true }],
    ['missing email claim', { missingEmail: true }],
  ]

  it.each(VALIDATION_FAILURES)(
    'a %s ID token produces the failure redirect with no session and no row',
    async (_label, defects) => {
      stub.setDefects(defects)
      const res = await finishFlow(flowApp, await beginFlow(flowApp))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(cookieValue(setCookie, SESSION_COOKIE_NAME)).toBeNull()
      expect(cookieValue(setCookie, FLOW_COOKIE_NAME)).toBe('')
      expect(await db.select().from(users)).toHaveLength(0)
    },
  )

  it('refuses a deactivated linked User', async () => {
    await db.insert(users).values({
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: null,
      role: 'member',
      status: 'deactivated',
      issuer: stub.url,
      subject: 'stub-subject-1',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
    expect(cookieValue(res.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME)).toBeNull()
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.status).toBe('deactivated')
  })

  it('refuses a deactivated password User whose email matches (deactivation holds on both doors)', async () => {
    await db.insert(users).values({
      name: 'Ada',
      email: 'alice@example.com',
      passwordHash: 'some-hash',
      role: 'member',
      status: 'deactivated',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.status).toBe('deactivated')
    expect(row?.issuer).toBeNull()
  })

  it('activates a linked-then-pending account', async () => {
    await db.insert(users).values({
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: null,
      role: 'member',
      status: 'pending',
      issuer: stub.url,
      subject: 'stub-subject-1',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800')
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.status).toBe('active')
  })

  it('links and activates a pending password User whose email matches', async () => {
    await db.insert(users).values({
      name: 'Ada',
      email: 'alice@example.com',
      passwordHash: 'some-hash',
      role: 'member',
      status: 'pending',
    })

    const res = await finishFlow(flowApp, await beginFlow(flowApp))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800')
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(row?.status).toBe('active')
    expect(row?.issuer).toBe(stub.url)
    expect(row?.subject).toBe('stub-subject-1')
  })

  it('refuses a callback with no flow cookie', async () => {
    const flow = await beginFlow(flowApp)
    const res = await flowApp.request(`/auth/oidc/callback?code=some-code&state=${encodeURIComponent(flow.state)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
    expect(cookieValue(res.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME)).toBeNull()
    expect(await db.select().from(users)).toHaveLength(0)
  })

  it('refuses a callback whose state does not match the flow cookie', async () => {
    const flow = await beginFlow(flowApp)
    const res = await flowApp.request(`/auth/oidc/callback?code=some-code&state=${encodeURIComponent(`${flow.state}-tampered`)}`, {
      headers: { cookie: `${FLOW_COOKIE_NAME}=${flow.flowCookie}` },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:4800?error=oidc_failed')
    expect(cookieValue(res.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME)).toBeNull()
    expect(await db.select().from(users)).toHaveLength(0)
  })

  it('fails loudly at login when the discovery document reports a different issuer', async () => {
    stub.setDiscoveryIssuer('https://evil.example/realms/monitorerp')
    // A fresh app instance carries no discovery cache — the mismatch is the
    // first thing the login endpoint sees (a misconfigured issuer must be
    // loud, never a hang: spec #57).
    const freshApp = makeApp(db, { ...TEST_CONFIG, oidc: oidcConfig })
    const res = await freshApp.request('/auth/oidc/login')
    expect(res.status).toBe(500)
  })

  it('takes the User name from the ID token profile, with the documented fallback chain', async () => {
    // The name claim wins.
    await finishFlow(flowApp, await beginFlow(flowApp))
    const [named] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(named?.name).toBe('Alice Example')

    // No name claim → given + family name.
    await truncateAll(db)
    stub.setUser({ subject: 'stub-subject-1', email: 'alice@example.com', givenName: 'Alice', familyName: 'Example' })
    await finishFlow(flowApp, await beginFlow(flowApp))
    const [givenFamily] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(givenFamily?.name).toBe('Alice Example')

    // No name/given/family → preferred username.
    await truncateAll(db)
    stub.setUser({ subject: 'stub-subject-1', email: 'alice@example.com', preferredUsername: 'alice.kb' })
    await finishFlow(flowApp, await beginFlow(flowApp))
    const [preferred] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(preferred?.name).toBe('alice.kb')

    // Nothing left → the email prefix.
    await truncateAll(db)
    stub.setUser({ subject: 'stub-subject-1', email: 'alice@example.com' })
    await finishFlow(flowApp, await beginFlow(flowApp))
    const [emailPrefix] = await db.select().from(users).where(eq(users.email, 'alice@example.com')).limit(1)
    expect(emailPrefix?.name).toBe('alice')
  })
})
