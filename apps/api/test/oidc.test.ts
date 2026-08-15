import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, OIDC_VARIABLES } from '../src/config.js'
import type { DB } from '../src/db/client.js'
import { createTestDatabase, makeApp, TEST_CONFIG, truncateAll, type TestDatabase } from './helpers.js'

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
