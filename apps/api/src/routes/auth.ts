import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../auth/middleware.js'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { toPublicUser } from '../auth/user.js'
import { SESSION_MAX_AGE_SECONDS, sessionCookieHeader, signSessionToken } from '../auth/jwt.js'
import { isUniqueViolation } from '../db/errors.js'
import { users } from '../db/schema.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { jsonValidator } from '../validation.js'

const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be at most 100 characters'),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password is too long'),
})

const signInSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
})

export function authRoutes(deps: Deps): Hono {
  const app = new Hono()

  app.post('/sign-up', jsonValidator(signUpSchema), async (c) => {
    const { name, email, password } = c.req.valid('json')
    try {
      const [user] = await deps.db
        .insert(users)
        .values({ name, email, passwordHash: await hashPassword(password), role: 'member', status: 'pending' })
        .returning()
      if (user === undefined) throw new Error('INSERT ... RETURNING returned no row')
      return c.json({ user: toPublicUser(user) }, 201)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(c, 409, 'duplicate_email', 'A user with this email already exists')
      }
      throw err
    }
  })

  app.post('/sign-in', jsonValidator(signInSchema), async (c) => {
    const { email, password } = c.req.valid('json')
    const [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1)
    // A passwordless account (OIDC-provisioned, issue #59) has no hash to
    // verify — it fails exactly like a wrong password: the standard
    // invalid-credentials response, never a server error.
    if (user === undefined || user.passwordHash === null || !(await verifyPassword(password, user.passwordHash))) {
      return sendError(c, 401, 'unauthorized', 'Invalid email or password')
    }
    if (user.status !== 'active') {
      const message =
        user.status === 'pending'
          ? 'Your account is awaiting activation by a super admin'
          : 'This account has been deactivated'
      return sendError(c, 403, 'forbidden', message)
    }
    const token = await signSessionToken(user.id, deps.config.jwtSecret)
    c.header('Set-Cookie', sessionCookieHeader(token, SESSION_MAX_AGE_SECONDS))
    return c.json({ user: toPublicUser(user) })
  })

  app.post('/sign-out', authMiddleware(deps), (c) => {
    c.header('Set-Cookie', sessionCookieHeader('', 0))
    return c.body(null, 204)
  })

  app.get('/me', authMiddleware(deps), (c) => c.json({ user: toPublicUser(c.get('user')) }))

  return app
}
