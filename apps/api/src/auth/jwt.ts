import { SignJWT, jwtVerify } from 'jose'

export const SESSION_COOKIE_NAME = 'kb_session'
// 7 days, no renewal in v1 (per issue #7).
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

const encoder = new TextEncoder()

export function signSessionToken(userId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    // jose interprets a numeric exp as an absolute epoch timestamp, so compute it.
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS)
    .sign(encoder.encode(secret))
}

/** Returns the token's subject (user id), or null when invalid or expired. */
export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret))
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

// Deliberately no `Secure` — the box runs plain HTTP internally (issue #7).
export function sessionCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}
