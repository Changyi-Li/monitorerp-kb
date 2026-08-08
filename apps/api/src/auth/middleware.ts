import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { Deps } from '../deps.js'
import { users } from '../db/schema.js'
import { sendError } from '../errors.js'
import { parseCookies } from '../http.js'
import type { User } from './user.js'
import { SESSION_COOKIE_NAME, verifySessionToken } from './jwt.js'

/**
 * Authenticates a request from the `kb_session` cookie. The user row is
 * loaded from the database on every request, so deactivation takes effect
 * immediately — a session is only valid while its user is still active.
 */
export function authMiddleware(deps: Deps) {
  return createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
    const token = parseCookies(c.req.header('cookie') ?? '').get(SESSION_COOKIE_NAME)
    const userId = token ? await verifySessionToken(token, deps.config.jwtSecret) : null
    const user = userId
      ? await deps.db.query.users.findFirst({ where: eq(users.id, userId) })
      : null
    if (user === null || user === undefined || user.status !== 'active') {
      return sendError(c, 401, 'unauthorized', 'Not signed in')
    }
    c.set('user', user)
    return next()
  })
}
