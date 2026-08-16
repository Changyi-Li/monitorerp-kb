import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

// Mirrors the committed realm artifact (keycloak/monitorerp-realm.json):
// the same realm path and the same client. The stub's issuer URL is its own
// base, so `OIDC_ISSUER_URL` points at the stub exactly as it points at the
// dev Keycloak.
export const OIDC_STUB_CLIENT_ID = 'monitorerp-kb'
export const OIDC_STUB_CLIENT_SECRET = 'test-oidc-secret'
const REALM_PATH = '/realms/monitorerp'

/** The Keycloak profile the stub presents as the signed-in user. */
export interface OidcStubUser {
  subject: string
  email: string
  name?: string
  givenName?: string
  familyName?: string
  preferredUsername?: string
}

/**
 * The ID-token defect modes the stub can mint, one per sign-in test. Each
 * mints a token a real Keycloak would never issue, so the API's validation
 * must reject it (spec #57's validation-failure matrix).
 */
export interface OidcStubDefects {
  /** Sign the ID token with a key that is NOT in the published JWKS. */
  badSignature: boolean
  /** Mint the ID token with a different issuer claim. */
  wrongIssuer: boolean
  /** Mint the ID token with a different audience claim. */
  wrongAudience: boolean
  /** Mint an ID token whose expiry is already past. */
  expired: boolean
  /** Omit the nonce claim entirely. */
  missingNonce: boolean
  /** Mint the ID token with a nonce that does not match the authorize request. */
  wrongNonce: boolean
  /** Omit the email claim entirely. */
  missingEmail: boolean
}

/** The token-endpoint requests the stub has served (wire-shape assertions). */
export interface StoredTokenRequest {
  code: string
  clientId: string | null
  clientSecret: string | null
  codeVerifier: string | null
}

export interface OidcStub {
  /** The issuer base the API's OIDC config points at. */
  url: string
  setUser: (user: OidcStubUser) => void
  setDefects: (defects: Partial<OidcStubDefects>) => void
  /** Serves a discovery document identifying a different issuer (misconfiguration). */
  setDiscoveryIssuer: (issuer: string) => void
  /** The authorize requests the stub has served, in order (their full query strings). */
  authorizeRequests: URLSearchParams[]
  tokenRequests: StoredTokenRequest[]
  close: () => Promise<void>
}

const DEFAULT_USER: OidcStubUser = {
  subject: 'stub-subject-1',
  email: 'alice@example.com',
  name: 'Alice Example',
  givenName: 'Alice',
  familyName: 'Example',
  preferredUsername: 'alice',
}

const CLEAN_DEFECTS: OidcStubDefects = {
  badSignature: false,
  wrongIssuer: false,
  wrongAudience: false,
  expired: false,
  missingNonce: false,
  wrongNonce: false,
  missingEmail: false,
}

/**
 * In-process stand-in for the Keycloak OIDC provider (per the testing
 * decision: the same pattern as the RagFlow stub). Serves the discovery
 * document, the JWKS, the authorize endpoint (issues a code bound to the
 * current stub user, the nonce, and the S256 challenge), and the token
 * endpoint (enforces the PKCE verifier and mints the ID token — optionally
 * defective). Tests drive the flow through the API's HTTP surface and mutate
 * the stub's user and defects between sign-ins.
 */
export async function startOidcStub(): Promise<OidcStub> {
  // The published key the API's JWKS validation must accept…
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  // …and the key bad-signature tokens are signed with (never published).
  const { privateKey: evilPrivateKey } = await generateKeyPair('RS256')

  let user: OidcStubUser = { ...DEFAULT_USER }
  // `setDefects` replaces the whole defect set (reset-then-apply), so a
  // defect never leaks into a later sign-in.
  const defects: OidcStubDefects = { ...CLEAN_DEFECTS }
  let discoveryIssuer: string | null = null
  const authorizeRequests: URLSearchParams[] = []
  const tokenRequests: StoredTokenRequest[] = []
  // Issued codes, single-use: code → the authorize request it came from.
  const codes = new Map<string, { challenge: string; nonce: string; user: OidcStubUser }>()

  const stub: OidcStub = {
    url: '',
    setUser: (next) => {
      user = { ...next }
    },
    setDefects: (next) => {
      Object.assign(defects, CLEAN_DEFECTS, next)
    },
    setDiscoveryIssuer: (issuer) => {
      discoveryIssuer = issuer
    },
    authorizeRequests,
    tokenRequests,
    close: () => Promise.resolve(),
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function mintIdToken(stored: { nonce: string; user: OidcStubUser }): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const payload: Record<string, unknown> = {
      iss: defects.wrongIssuer ? 'https://evil.example/realms/monitorerp' : stub.url,
      sub: stored.user.subject,
      aud: defects.wrongAudience ? 'some-other-client' : OIDC_STUB_CLIENT_ID,
      iat: now,
      exp: defects.expired ? now - 300 : now + 300,
    }
    if (!defects.missingNonce) {
      payload['nonce'] = defects.wrongNonce ? `${stored.nonce}-tampered` : stored.nonce
    }
    if (!defects.missingEmail) payload['email'] = stored.user.email
    if (stored.user.name !== undefined) payload['name'] = stored.user.name
    if (stored.user.givenName !== undefined) payload['given_name'] = stored.user.givenName
    if (stored.user.familyName !== undefined) payload['family_name'] = stored.user.familyName
    if (stored.user.preferredUsername !== undefined) payload['preferred_username'] = stored.user.preferredUsername

    const key = defects.badSignature ? evilPrivateKey : privateKey
    return await new SignJWT(payload).setProtectedHeader({ alg: 'RS256' }).sign(key)
  }

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === `${REALM_PATH}/.well-known/openid-configuration`) {
      json(200, {
        issuer: discoveryIssuer ?? stub.url,
        authorization_endpoint: `${stub.url}/protocol/openid-connect/auth`,
        token_endpoint: `${stub.url}/protocol/openid-connect/token`,
        jwks_uri: `${stub.url}/protocol/openid-connect/certs`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
      })
      return
    }

    if (req.method === 'GET' && url.pathname === `${REALM_PATH}/protocol/openid-connect/certs`) {
      // Only the good key is ever published — bad-signature tokens cannot
      // validate against this set.
      json(200, { keys: [publicJwk] })
      return
    }

    // The mock authorize step: like Keycloak's login page, it issues a code
    // bound to the current user, the request's nonce, and the S256 challenge,
    // then redirects the browser back to the registered redirect URI.
    if (req.method === 'GET' && url.pathname === `${REALM_PATH}/protocol/openid-connect/auth`) {
      const params = new URLSearchParams(url.searchParams)
      authorizeRequests.push(params)
      const state = params.get('state')
      const redirectUri = params.get('redirect_uri')
      const challenge = params.get('code_challenge')
      const nonce = params.get('nonce')
      if (state === null || redirectUri === null || challenge === null || nonce === null) {
        json(400, { error: 'invalid_request' })
        return
      }
      const code = randomUUID()
      codes.set(code, { challenge, nonce, user: { ...user } })
      const callback = new URL(redirectUri)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', state)
      res.writeHead(302, { location: callback.toString() })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === `${REALM_PATH}/protocol/openid-connect/token`) {
      const body = new URLSearchParams(await readBody(req))
      const code = body.get('code')
      const verifier = body.get('code_verifier')
      tokenRequests.push({
        code: code ?? '',
        clientId: body.get('client_id'),
        clientSecret: body.get('client_secret'),
        codeVerifier: verifier,
      })
      const stored = code !== null ? codes.get(code) : undefined
      if (stored === undefined) {
        json(400, { error: 'invalid_grant', error_description: 'Code not found' })
        return
      }
      // Real Keycloak enforces PKCE S256: a token exchange without the
      // matching verifier must fail, so a client regression is observable.
      if (verifier === null || createHash('sha256').update(verifier).digest('base64url') !== stored.challenge) {
        json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        return
      }
      codes.delete(code as string)
      json(200, {
        access_token: 'stub-access-token',
        id_token: await mintIdToken(stored),
        token_type: 'Bearer',
        expires_in: 300,
      })
      return
    }

    json(404, { error: 'not_found' })
  }

  async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${port}${REALM_PATH}`
  stub.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined ? reject(err) : resolve()))
    })
  return stub
}
