import { asc, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../auth/middleware.js'
import type { User } from '../auth/user.js'
import { createCompletionTransform } from '../chat/transform.js'
import { chatSessions } from '../db/schema.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { RagflowError } from '../ragflow/client.js'
import { jsonValidator, queryValidator } from '../validation.js'

const DEFAULT_PAGE_SIZE = 20
const MAX_QUERY_LENGTH = 4000

const completionBodySchema = z.object({
  // Omitted ⇒ lazy create: RagFlow auto-creates the session on first message.
  session_id: z.uuid().optional(),
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(['updated_at_desc', 'updated_at_asc']).default('updated_at_desc'),
})

export interface ChatSessionShape {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export function chatSessionShape(row: typeof chatSessions.$inferSelect): ChatSessionShape {
  return {
    id: row.id,
    title: row.title,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

/** Sidebar title from the first message: trimmed, whitespace collapsed, capped. */
export function titleFromMessage(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, ' ')
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed
}

/**
 * Yields complete SSE frames (split on `\n\n`) from a byte stream, tolerating
 * frames split across network chunks. A frame missing its trailing blank line
 * (stream cut short) is still yielded.
 */
async function* sseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      if (frame.trim() !== '') yield frame
      split = buffer.indexOf('\n\n')
    }
  }
  const tail = buffer
  if (tail.trim() !== '') yield tail
}

export function chatRoutes(deps: Deps) {
  const app = new Hono<{ Variables: { user: User } }>()
  app.use('*', authMiddleware(deps))

  // POST /chat/completions — proxies RagFlow's agent completion SSE through
  // the pure transform. No session_id ⇒ lazy create: the row is inserted on
  // the first frame carrying RagFlow's auto-created session id, and a leading
  // `session` event with OUR id is forwarded so the client can pin the URL.
  app.post('/completions', jsonValidator(completionBodySchema), async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')

    const existingSessionId = body.session_id
    let resumed = false
    let ragflowSessionId: string | null = null
    if (existingSessionId !== undefined) {
      const [row] = await deps.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, existingSessionId))
        .limit(1)
      if (row === undefined) return sendError(c, 404, 'not_found', 'Chat session not found')
      // Chat sessions are strictly per-user — no super-admin override (spec #23).
      if (row.ownerId !== user.id) return sendError(c, 403, 'forbidden', 'Not your chat session')
      resumed = true
      ragflowSessionId = row.ragflowSessionId
    }

    let upstream: Response
    try {
      upstream = await deps.agent.completions({ sessionId: ragflowSessionId, query: body.query })
    } catch (err) {
      if (err instanceof RagflowError) return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
      throw err
    }
    if (!upstream.ok || upstream.body === null) {
      return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
    }
    const upstreamBody: ReadableStream<Uint8Array> = upstream.body

    const lazy = ragflowSessionId === null
    const transform = createCompletionTransform({ lazy })
    const title = titleFromMessage(body.query)

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        // A consumer that cancels the response (client aborted, proxy closed
        // the connection) leaves the controller closed — enqueues then throw
        // ERR_INVALID_STATE and must not crash the route.
        const emit = (event: string, data: unknown): void => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            // Nothing more to write — the consumer is gone.
          }
        }
        // `terminal` — a done/error event already ended the logical stream;
        // `failed` — the stream ended in an error (no updatedAt bump).
        let terminal = false
        let failed = false
        let createdRowId: string | null = null
        try {
          for await (const frame of sseFrames(upstreamBody)) {
            for (const event of transform.feed(frame)) {
              if (event.type === 'session') {
                const [row] = await deps.db
                  .insert(chatSessions)
                  .values({ ownerId: user.id, ragflowSessionId: event.id, title })
                  .returning()
                if (row === undefined) throw new Error('INSERT ... RETURNING returned no row')
                createdRowId = row.id
                emit('session', { id: row.id })
              } else if (event.type === 'answer') {
                emit('answer', { delta: event.delta })
              } else if (event.type === 'done') {
                terminal = true
                if (lazy && createdRowId === null) {
                  // Upstream anomaly: a lazy stream that never carried the
                  // auto-created session id — the client must not pin a URL.
                  failed = true
                  emit('error', { code: 'upstream_error', message: 'RagFlow did not create a session' })
                } else {
                  emit('done', {})
                }
              } else {
                terminal = true
                failed = true
                emit('error', { code: event.code, message: event.message })
              }
            }
          }
        } catch (err) {
          if (err instanceof Error) console.error(err)
          if (!terminal) {
            terminal = true
            failed = true
            emit('error', { code: 'upstream_error', message: 'The answer could not be completed' })
          }
        } finally {
          // A follow-up that streamed successfully reactivates the session —
          // the sidebar orders by activity. A failed stream leaves it put.
          if (resumed && !failed && existingSessionId !== undefined) {
            await deps.db
              .update(chatSessions)
              .set({ updatedAt: new Date() })
              .where(eq(chatSessions.id, existingSessionId))
          }
          try {
            controller.close()
          } catch {
            // Already closed by the consumer's cancellation.
          }
        }
      },
    })

    // `connection: close`: each completion is a short-lived SSE burst, and a
    // reused keep-alive connection after an SSE response can be left in a
    // half-closed state by the dev proxy — the next completion on that
    // connection is then cancelled before its first byte. Closing the
    // connection forces every completion onto a fresh socket.
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' },
    })
  })

  // GET /chat/sessions?page=&page_size=&sort= — the caller's own sessions,
  // from our table; no RagFlow call (spec #23).
  app.get('/sessions', queryValidator(listQuerySchema), async (c) => {
    const user = c.get('user')
    const query = c.req.valid('query')
    const where = eq(chatSessions.ownerId, user.id)

    const [countRow] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatSessions)
      .where(where)
    const total = countRow?.count ?? 0

    const rows = await deps.db
      .select()
      .from(chatSessions)
      .where(where)
      .orderBy(query.sort === 'updated_at_asc' ? asc(chatSessions.updatedAt) : desc(chatSessions.updatedAt))
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size)

    return c.json({
      items: rows.map(chatSessionShape),
      total,
      page: query.page,
      page_size: query.page_size,
    })
  })

  return app
}
