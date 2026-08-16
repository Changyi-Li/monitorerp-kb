import { and, eq } from 'drizzle-orm'
import type { User } from '../auth/user.js'
import type { DB } from '../db/client.js'
import { isUniqueViolation } from '../db/errors.js'
import { users } from '../db/schema.js'
import type { VerifiedIdentity } from './issuer.js'

/** The reasons an OIDC sign-in is refused (all produce the failure redirect). */
export type OidcRefusalReason = 'deactivated' | 'conflict'

/** A verified OIDC identity whose sign-in must be refused, not provisioned. */
export class OidcRefusedError extends Error {
  constructor(readonly reason: OidcRefusalReason) {
    super(`OIDC sign-in refused: ${reason}`)
    this.name = 'OidcRefusedError'
  }
}

/**
 * Provisions or links the User for a verified OIDC identity (spec #57):
 *
 * 1. Found by (issuer, subject) — the returning User: a deactivated User is
 *    refused; a linked-then-pending User is activated; otherwise the User is
 *    signed in as-is.
 * 2. Not found, but a User with the identity's email exists — if the row
 *    holds no OIDC identity it is linked (a pending password User becomes
 *    active); a deactivated User is refused; a row already holding a
 *    *different* OIDC identity is refused with a conflict.
 * 3. Not found at all — the User is created as an active Member with no
 *    password; the identity provider vouches for them.
 *
 * Identity is keyed by the provider's stable subject, never by email. The
 * unique (issuer, subject) index guards the concurrent first-sign-in race:
 * the loser retries once and finds the winner's row.
 */
export async function provisionOrLinkUser(db: DB, identity: VerifiedIdentity): Promise<User> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptOnce(db, identity)
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 1) throw err
      // Retry once: the concurrent first sign-in created the row between our
      // lookup and insert; the retry's lookup finds it.
    }
  }
}

async function attemptOnce(db: DB, identity: VerifiedIdentity): Promise<User> {
  const byIdentity = await db
    .select()
    .from(users)
    .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject)))
    .limit(1)
  if (byIdentity[0] !== undefined) {
    if (byIdentity[0].status === 'deactivated') throw new OidcRefusedError('deactivated')
    if (byIdentity[0].status === 'pending') {
      const [updated] = await db
        .update(users)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(users.id, byIdentity[0].id))
        .returning()
      if (updated === undefined) throw new Error('UPDATE ... RETURNING returned no row')
      return updated
    }
    return byIdentity[0]
  }

  const byEmail = await db.select().from(users).where(eq(users.email, identity.email)).limit(1)
  if (byEmail[0] !== undefined) {
    if (byEmail[0].issuer !== null) throw new OidcRefusedError('conflict')
    if (byEmail[0].status === 'deactivated') throw new OidcRefusedError('deactivated')
    const [updated] = await db
      .update(users)
      .set({ issuer: identity.issuer, subject: identity.subject, status: 'active', updatedAt: new Date() })
      .where(eq(users.id, byEmail[0].id))
      .returning()
    if (updated === undefined) throw new Error('UPDATE ... RETURNING returned no row')
    return updated
  }

  const [created] = await db
    .insert(users)
    .values({
      name: identity.name,
      email: identity.email,
      passwordHash: null,
      role: 'member',
      status: 'active',
      issuer: identity.issuer,
      subject: identity.subject,
    })
    .returning()
  if (created === undefined) throw new Error('INSERT ... RETURNING returned no row')
  return created
}
