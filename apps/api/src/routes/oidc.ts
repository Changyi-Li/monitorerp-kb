import { createHash, randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { SESSION_MAX_AGE_SECONDS, sessionCookieHeader, signSessionToken } from '../auth/jwt.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { parseCookies } from '../http.js'
import { createOidcIssuerClient, type OidcIssuerClient } from '../oidc/issuer.js'
import { OidcRefusedError, provisionOrLinkUser } from '../oidc/provision.js'

/**
 * OIDC sign-in (Keycloak) contract under /auth (spec #57; issues #58, #61).
 *
 * The capability endpoint reports the feature state to the web: disabled
 * when no OIDC_* variables are configured, enabled with the login URL
 * otherwise. With OIDC enabled, the API owns the authorization-code + PKCE
 * flow end to end:
 *
 * - `/login` issues the short-lived `kb_oidc_flow` cookie — state, nonce,
 *   and the PKCE verifier, opaque to the browser — and redirects to the
 *   issuer's authorization endpoint with the S256 challenge.
 * - `/callback` validates the state, exchanges the code with the verifier,
 *   validates the ID token against the issuer's published keys, provisions
 *   or links the User, sets the same `kb_session` cookie as password
 *   sign-in, clears the flow cookie, and redirects to the web origin. Any
 *   failure clears the flow cookie and redirects with `error=oidc_failed`
 *   (the web renders the message, issue #62).
 *
 * When OIDC is disabled the flow endpoints are inert — the same 404 an
 * unregistered route answers — so an unconfigured deployment behaves exactly
 * as before OIDC existed.
 */

/** The flow cookie: state + nonce + PKCE verifier, one browser flow at a time. */
export const FLOW_COOKIE_NAME = 'kb_oidc_flow'
// The verifier, state, and nonce are only needed for the minutes the browser
// spends at the identity provider (spec #57: 10 minutes, HttpOnly, SameSite=Lax).
export const FLOW_MAX_AGE_SECONDS = 10 * 60

// The scopes the app asks the issuer for (spec #57): the profile claims the
// account's name and email come from.
const OIDC_SCOPES = 'openid email profile'

/** The failure-redirect query parameter the web renders (spec #57, issue #62). */
const OIDC_ERROR_PARAM = 'oidc_failed'

export function flowCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${FLOW_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}

export function oidcRoutes(deps: Deps): Hono {
  const app = new Hono()
  const oidc = deps.config.oidc
  // One issuer client per app: the discovery document and JWKS are cached
  // inside it for an hour.
  const issuer: OidcIssuerClient | null = oidc !== null ? createOidcIssuerClient(oidc) : null

  app.get('/config', (c) => {
    if (oidc === null) return c.json({ enabled: false })
    return c.json({ enabled: true, loginUrl: oidc.loginUrl })
  })

  // Inert when OIDC is disabled (issue #58): the flow endpoints answer the
  // same 404 an unregistered route answers.
  const inert = (c: Context): Response => sendError(c, 404, 'not_found', 'Not found')

  app.get('/login', async (c) => {
    if (oidc === null || issuer === null) return inert(c)
    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    // PKCE S256: the verifier rides the flow cookie; only its challenge ever
    // leaves the API (spec #57).
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const doc = await issuer.discovery()
    const authorizationUrl = new URL(doc.authorization_endpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', oidc.clientId)
    authorizationUrl.searchParams.set('redirect_uri', oidc.redirectUri)
    authorizationUrl.searchParams.set('scope', OIDC_SCOPES)
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('nonce', nonce)
    authorizationUrl.searchParams.set('code_challenge', challenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    const res = c.redirect(authorizationUrl.toString(), 302)
    res.headers.append(
      'Set-Cookie',
      flowCookieHeader(Buffer.from(JSON.stringify({ state, nonce, verifier })).toString('base64url'), FLOW_MAX_AGE_SECONDS),
    )
    return res
  })

  app.get('/callback', async (c) => {
    if (oidc === null || issuer === null) return inert(c)
    // The post-callback redirect target: the web origin (spec #57 — the
    // browser returns to the web app, success or failure). The redirect URI
    // is registered as `<web origin>/api/auth/oidc/callback`, so the URL
    // origin is exactly the redirect URI minus the fixed callback suffix.
    const webOrigin = new URL(oidc.redirectUri).origin

    const failureRedirect = (): Response => {
      const res = c.redirect(`${webOrigin}?error=${OIDC_ERROR_PARAM}`, 302)
      res.headers.append('Set-Cookie', flowCookieHeader('', 0))
      return res
    }

    const cookies = parseCookies(c.req.header('cookie') ?? '')
    const flowValue = cookies.get(FLOW_COOKIE_NAME)
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (flowValue === undefined || code === undefined || state === undefined) return failureRedirect()

    let flow: { state?: unknown; nonce?: unknown; verifier?: unknown }
    try {
      flow = JSON.parse(Buffer.from(flowValue, 'base64url').toString('utf8')) as {
        state?: unknown
        nonce?: unknown
        verifier?: unknown
      }
    } catch {
      return failureRedirect()
    }
    if (flow.state !== state || typeof flow.nonce !== 'string' || typeof flow.verifier !== 'string') {
      return failureRedirect()
    }

    try {
      const idToken = await issuer.exchangeCode(code, flow.verifier)
      const identity = await issuer.verifyIdToken(idToken, flow.nonce)
      const user = await provisionOrLinkUser(deps.db, identity)
      const token = await signSessionToken(user.id, deps.config.jwtSecret)
      const res = c.redirect(webOrigin, 302)
      res.headers.append('Set-Cookie', sessionCookieHeader(token, SESSION_MAX_AGE_SECONDS))
      res.headers.append('Set-Cookie', flowCookieHeader('', 0))
      return res
    } catch (err) {
      // Every failure ends in the generic failure redirect (the web renders
      // the message, issue #62); log the reason for operators — the browser
      // never sees it.
      const detail = err instanceof OidcRefusedError ? `refused (${err.reason})` : String(err)
      console.warn(`OIDC sign-in failed: ${detail}`)
      return failureRedirect()
    }
  })

  return app
}
