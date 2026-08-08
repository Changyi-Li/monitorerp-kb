import { and, asc, count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../auth/middleware.js'
import { toPublicUser } from '../auth/user.js'
import type { User } from '../auth/user.js'
import type { DB } from '../db/client.js'
import { users } from '../db/schema.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { isUuid } from '../ids.js'
import { queryValidator, jsonValidator } from '../validation.js'

const listQuerySchema = z.object({
  status: z.enum(['active', 'pending', 'deactivated']).optional(),
  role: z.enum(['member', 'super_admin']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

const patchSchema = z.object({
  role: z.enum(['member', 'super_admin']).optional(),
  status: z.enum(['active', 'pending', 'deactivated']).optional(),
})

/** Rejects the request unless the caller is a super admin. */
function requireSuperAdmin(c: { get: (key: 'user') => User }) {
  return c.get('user').role === 'super_admin'
}

async function countActiveSuperAdmins(db: DB): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(users)
    .where(and(eq(users.role, 'super_admin'), eq(users.status, 'active')))
  return row?.count ?? 0
}

/**
 * The last active super admin can never be demoted or deactivated (per the
 * glossary) — the system must keep administrative access.
 */
async function isLastActiveSuperAdmin(db: DB, user: User): Promise<boolean> {
  if (user.role !== 'super_admin' || user.status !== 'active') return false
  return (await countActiveSuperAdmins(db)) === 1
}

export function usersRoutes(deps: Deps) {
  const app = new Hono<{ Variables: { user: User } }>()
  app.use('*', authMiddleware(deps))

  // GET /users?status=&role=&page=&page_size= — super admin only.
  app.get('/', queryValidator(listQuerySchema), async (c) => {
    if (!requireSuperAdmin(c)) return sendError(c, 403, 'forbidden', 'Super admin only')
    const query = c.req.valid('query')
    const filters = []
    if (query.status !== undefined) filters.push(eq(users.status, query.status))
    if (query.role !== undefined) filters.push(eq(users.role, query.role))
    const where = filters.length > 0 ? and(...filters) : undefined

    const [countRow] = await deps.db.select({ count: count() }).from(users).where(where)
    const total = countRow?.count ?? 0

    const rows = await deps.db
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(users.createdAt))
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size)

    const onlyOneActiveAdmin = (await countActiveSuperAdmins(deps.db)) === 1

    // Corpus-wide per-status counts for the pending-activation badge.
    const counts: Record<'active' | 'pending' | 'deactivated', number> = { active: 0, pending: 0, deactivated: 0 }
    const countRows = await deps.db.select({ status: users.status, count: count() }).from(users).groupBy(users.status)
    for (const row of countRows) counts[row.status] = row.count

    return c.json({
      items: rows.map((user) => ({
        ...toPublicUser(user),
        is_last_admin: onlyOneActiveAdmin && user.role === 'super_admin' && user.status === 'active',
      })),
      total,
      page: query.page,
      page_size: query.page_size,
      counts,
    })
  })

  // PATCH /users/:id {role?, status?} — super admin only; guarded transitions.
  app.patch('/:id', jsonValidator(patchSchema), async (c) => {
    if (!requireSuperAdmin(c)) return sendError(c, 403, 'forbidden', 'Super admin only')
    const id = c.req.param('id')
    if (!isUuid(id)) return sendError(c, 404, 'not_found', 'User not found')
    const { role, status } = c.req.valid('json')
    if (role === undefined && status === undefined) {
      return sendError(c, 400, 'validation_error', 'Nothing to update')
    }
    const [target] = await deps.db.select().from(users).where(eq(users.id, id)).limit(1)
    if (target === undefined) return sendError(c, 404, 'not_found', 'User not found')

    // Pending accounts can only be activated — no role or other status change.
    if (target.status === 'pending' && (role !== undefined || status !== 'active')) {
      return sendError(c, 409, 'wrong_status', 'Pending accounts can only be activated')
    }
    if (status === 'pending' && target.status !== 'pending') {
      return sendError(c, 409, 'wrong_status', 'Cannot set a user to pending')
    }

    const removingLastAdmin =
      (status !== undefined && status !== 'active') || role === 'member'
    if (removingLastAdmin && (await isLastActiveSuperAdmin(deps.db, target))) {
      return sendError(c, 409, 'last_admin', 'The last active super admin cannot be demoted or deactivated')
    }

    const [updated] = await deps.db
      .update(users)
      .set({
        ...(role !== undefined ? { role } : {}),
        ...(status !== undefined ? { status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning()
    if (updated === undefined) throw new Error('UPDATE ... RETURNING returned no row')
    return c.json({ user: toPublicUser(updated) })
  })

  return app
}
