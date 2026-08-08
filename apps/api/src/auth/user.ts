import type { users } from '../db/schema.js'

export type User = typeof users.$inferSelect

export interface PublicUser {
  id: string
  name: string
  email: string
  role: 'member' | 'super_admin'
  status: 'active' | 'pending' | 'deactivated'
  created_at: string
  updated_at: string
}

/** The user shape returned to clients (never includes the password hash). */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  }
}
