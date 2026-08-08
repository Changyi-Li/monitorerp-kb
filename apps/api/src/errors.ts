import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Codes from the spec's error envelope; the list grows with each ticket.
export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'duplicate_email'
  | 'internal'

/** Sends the `{error: {code, message, fields?}}` envelope (issue #6 contract). */
export function sendError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): Response {
  return c.json(
    { error: { code, message, ...(fields !== undefined ? { fields } : {}) } },
    status,
  )
}
