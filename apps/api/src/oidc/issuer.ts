import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'
import type { OidcConfig } from '../config.js'

/** The subset of the issuer's discovery document the flow uses. */
export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/**
 * The identity claims the app trusts from a validated ID token — the
 * account's identity link (issuer + subject) and its profile (email, name).
 */
export interface VerifiedIdentity {
  issuer: string
  subject: string
  email: string
  name: string
}

export interface OidcIssuerClient {
  /** The issuer's discovery document, fetched lazily and cached for one hour. */
  discovery(): Promise<DiscoveryDocument>
  /**
   * Exchanges an authorization code for tokens at the token endpoint. The
   * issuer enforces the PKCE verifier; the returned ID token is not yet
   * validated.
   */
  exchangeCode(code: string, codeVerifier: string): Promise<string>
  /**
   * Validates an ID token against the issuer's published keys — signature,
   * issuer, audience (the client id), nonce, and expiry — and returns its
   * identity claims. Throws on any validation failure.
   */
  verifyIdToken(idToken: string, nonce: string): Promise<VerifiedIdentity>
}

// The spec's caching decision: the discovery document and JWKS are fetched
// lazily (API boot never depends on Keycloak being reachable) and cached for
// one hour.
const CACHE_TTL_MS = 60 * 60 * 1000

/** A non-empty string claim, or null when absent or blank. */
function claim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The name stored on the User's account, from the ID token's profile claims
 * (spec #57): the `name` claim, then given + family name, then
 * `preferred_username`, then the email prefix. The email claim is already
 * required by the caller, so the last fallback always applies.
 */
function deriveName(payload: JWTPayload): string {
  const name = claim(payload['name'])
  if (name !== null) return name
  const given = claim(payload['given_name'])
  const family = claim(payload['family_name'])
  if (given !== null && family !== null) return `${given} ${family}`
  if (given !== null) return given
  if (family !== null) return family
  const preferredUsername = claim(payload['preferred_username'])
  if (preferredUsername !== null) return preferredUsername
  const email = claim(payload['email']) ?? ''
  const at = email.indexOf('@')
  return at === -1 ? email : email.slice(0, at)
}

export function createOidcIssuerClient(oidc: OidcConfig): OidcIssuerClient {
  let cached: { doc: DiscoveryDocument; fetchedAt: number } | null = null
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

  async function discovery(): Promise<DiscoveryDocument> {
    const now = Date.now()
    if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) return cached.doc
    const res = await fetch(`${oidc.issuerUrl}/.well-known/openid-configuration`)
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${oidc.issuerUrl}: HTTP ${res.status}`)
    }
    const doc = (await res.json()) as Partial<DiscoveryDocument>
    for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[key] !== 'string' || doc[key] === '') {
        throw new Error(`OIDC discovery for ${oidc.issuerUrl} is missing the ${key} field`)
      }
    }
    // The discovery document must identify itself as the configured issuer —
    // a document served for a different issuer is a misconfiguration or a
    // proxy mistake, and the ID token's iss claim is validated against the
    // configured URL, so the two must agree.
    if (doc.issuer !== oidc.issuerUrl) {
      throw new Error(`OIDC discovery for ${oidc.issuerUrl} reports a different issuer: ${doc.issuer}`)
    }
    cached = { doc: doc as DiscoveryDocument, fetchedAt: now }
    return cached.doc
  }

  async function exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const doc = await discovery()
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oidc.redirectUri,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        code_verifier: codeVerifier,
      }),
    })
    if (!res.ok) {
      throw new Error(`OIDC token exchange failed: HTTP ${res.status}`)
    }
    const payload = (await res.json()) as { id_token?: unknown }
    if (typeof payload.id_token !== 'string' || payload.id_token === '') {
      throw new Error('OIDC token exchange returned no id_token')
    }
    return payload.id_token
  }

  async function verifyIdToken(idToken: string, nonce: string): Promise<VerifiedIdentity> {
    const doc = await discovery()
    // The JWKS endpoint comes from discovery; the set itself caches the keys
    // for the same one-hour window (jose re-fetches after cacheMaxAge).
    if (jwks === null) {
      jwks = createRemoteJWKSet(new URL(doc.jwks_uri), { cacheMaxAge: CACHE_TTL_MS })
    }
    // jose enforces signature, expiry, and (via the options) issuer and
    // audience; the nonce claim must be present and must match the flow
    // cookie's — jose v6 has no nonce option, so the match is checked here
    // (a missing claim fails the requiredClaims check).
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: oidc.issuerUrl,
      audience: oidc.clientId,
      requiredClaims: ['nonce'],
    })
    const subject = claim(payload['sub'])
    const email = claim(payload['email'])
    if (subject === null || email === null) {
      throw new Error('OIDC ID token is missing the required sub or email claim')
    }
    if (payload['nonce'] !== nonce) {
      throw new Error('OIDC ID token nonce does not match the flow')
    }
    return {
      // The issuer option above guarantees the token's iss claim equals the
      // configured issuer URL, so either is the provider's issuer.
      issuer: oidc.issuerUrl,
      subject,
      email,
      name: deriveName(payload),
    }
  }

  return { discovery, exchangeCode, verifyIdToken }
}
