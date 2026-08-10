import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import type { DB } from '../src/db/client.js'
import { chatSessions, users } from '../src/db/schema.js'
import { createTestDatabase, makeApp, TEST_CONFIG, truncateAll, type TestDatabase } from './helpers.js'
import { startRagflowStub, type RagflowStub } from './ragflow-stub.js'

let db: DB
let close: () => Promise<void>
let app: Hono
let stub: RagflowStub

beforeAll(async () => {
  const created: TestDatabase = await createTestDatabase()
  db = created.db
  close = created.close
  stub = await startRagflowStub()
  app = makeApp(db, { ...TEST_CONFIG, ragflowUrl: stub.url })
})

afterAll(async () => {
  await stub.close()
  await close()
})

beforeEach(async () => {
  await truncateAll(db)
  stub.completionRequests.length = 0
  stub.failCompletions = false
})

const MEMBER = { email: 'member@example.com', password: 'correct-horse' }
const OTHER = { email: 'other@example.com', password: 'correct-horse' }

/** Creates an active member directly and returns a session cookie. */
async function activeMemberCookie(email = MEMBER.email): Promise<string> {
  await app.request('/auth/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace', email, password: MEMBER.password }),
  })
  await db.update(users).set({ status: 'active' }).where(eq(users.email, email))
  const res = await app.request('/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: MEMBER.password }),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const value = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  if (value === undefined) throw new Error('sign-in failed: no session cookie')
  return value
}

const cookieHeader = (cookie: string): { cookie: string } => ({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` })

interface SseEvent {
  event: string
  data: { id?: string; delta?: string; code?: string }
}

/** Joins every answer delta — the stub streams the answer in word-level deltas. */
function answerText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'answer')
    .map((e) => e.data.delta ?? '')
    .join('')
}

/** Asserts the canonical session → answer… → done event order. */
function expectStreamShape(events: SseEvent[]): void {
  expect(events[0]?.event).toBe('session')
  expect(events.at(-1)?.event).toBe('done')
  expect(events.slice(1, -1).every((e) => e.event === 'answer')).toBe(true)
}

/** Consumes the whole SSE body and parses it into events. */
async function sseOf(res: Response): Promise<SseEvent[]> {
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const body = await res.text()
  const events: SseEvent[] = []
  for (const block of body.split('\n\n')) {
    let event = 'message'
    let data: string | null = null
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data = line.slice(5).trim()
    }
    if (data !== null) events.push({ event, data: JSON.parse(data) as SseEvent['data'] })
  }
  return events
}

async function completions(cookie: string, body: unknown): Promise<Response> {
  return await app.request('/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
    body: JSON.stringify(body),
  })
}

interface WireSession {
  id: string
  title: string
  created_at: string
  updated_at: string
}

interface WireList {
  items: WireSession[]
  total: number
  page: number
  page_size: number
}

describe('POST /chat/completions', () => {
  it('lazily creates a session and streams session → answer → done', async () => {
    const cookie = await activeMemberCookie()
    const events = await sseOf(await completions(cookie, { query: 'How many leave days do I get?' }))

    expectStreamShape(events)
    const sessionId = events[0]?.data.id
    expect(sessionId).toBeTypeOf('string')
    // The stub's scripted stream splits the <think> tags across deltas; the
    // proxy strips them — only the answer reaches the client.
    expect(answerText(events)).toBe('Leave is capped at 21 days per year. It resets every calendar year.')

    // The stub saw a lazy request (no session_id) and auto-created one.
    expect(stub.completionRequests).toHaveLength(1)
    expect(stub.completionRequests[0]?.sessionId).toBeNull()
    expect(stub.completionRequests[0]?.agentId).toBe('dev-agent')

    // Our row mirrors metadata only: id, owner, the RagFlow session id, title.
    const rows = await db.select().from(chatSessions)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(sessionId)
    expect(rows[0]?.title).toBe('How many leave days do I get?')
    expect(rows[0]?.ragflowSessionId).toBe(stub.completionRequests[0]?.streamedSessionId)
    expect(rows[0]?.ownerId).toBeTypeOf('string')
  })

  it('a follow-up message reuses the session without a session event', async () => {
    const cookie = await activeMemberCookie()
    const first = await sseOf(await completions(cookie, { query: 'First question' }))
    const sessionId = first[0]?.data.id
    expect(sessionId).toBeTypeOf('string')

    const events = await sseOf(await completions(cookie, { session_id: sessionId, query: 'Follow up?' }))
    expect(events[0]?.event).toBe('answer')
    expect(events.at(-1)?.event).toBe('done')
    expect(events.slice(0, -1).every((e) => e.event === 'answer')).toBe(true)
    expect(answerText(events)).toBe('Leave is capped at 21 days per year. It resets every calendar year.')

    // The proxy sent the RagFlow session id this time, not a lazy request.
    expect(stub.completionRequests).toHaveLength(2)
    expect(stub.completionRequests[1]?.sessionId).toBe(stub.completionRequests[0]?.streamedSessionId)
    // Still exactly one row.
    expect(await db.select().from(chatSessions)).toHaveLength(1)
  })

  it('returns 404 for an unknown session id and 403 for another user\'s session', async () => {
    const alice = await activeMemberCookie()
    const events = await sseOf(await completions(alice, { query: 'Mine' }))
    const sessionId = events[0]?.data.id
    expect(sessionId).toBeTypeOf('string')

    const missing = await completions(alice, { session_id: '00000000-0000-0000-0000-000000000000', query: 'hi' })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found')

    // Strictly per-user: the other member cannot talk into Alice's session.
    const bob = await activeMemberCookie(OTHER.email)
    const foreign = await completions(bob, { session_id: sessionId, query: 'hi' })
    expect(foreign.status).toBe(403)
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    expect(stub.completionRequests).toHaveLength(1) // the foreign request never reached RagFlow
  })

  it('returns 400 validation_error for a bad body', async () => {
    const cookie = await activeMemberCookie()
    const missingQuery = await completions(cookie, {})
    expect(missingQuery.status).toBe(400)
    const blank = await completions(cookie, { query: '   ' })
    expect(blank.status).toBe(400)
    const badId = await completions(cookie, { session_id: 'not-a-uuid', query: 'hi' })
    expect(badId.status).toBe(400)
    expect(stub.completionRequests).toHaveLength(0)
  })

  it('returns 502 upstream_error when RagFlow fails', async () => {
    const cookie = await activeMemberCookie()
    stub.failCompletions = true
    const res = await completions(cookie, { query: 'hi' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_error')
  })

  it('requires a session', async () => {
    const res = await app.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hi' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /chat/sessions', () => {
  it('lists the caller\'s own sessions, most recently updated first', async () => {
    const cookie = await activeMemberCookie()
    const first = await sseOf(await completions(cookie, { query: 'First session' }))
    const firstId = first[0]?.data.id
    expect(firstId).toBeTypeOf('string')
    await sseOf(await completions(cookie, { query: 'Second session' }))

    const res = await app.request('/chat/sessions', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as WireList
    expect(body.items.map((s) => s.title)).toEqual(['Second session', 'First session'])
    expect(body.total).toBe(2)
    expect(body.page).toBe(1)
    for (const item of body.items) {
      expect(item.id).toBeTypeOf('string')
      expect(item.created_at).toBeTypeOf('string')
      expect(item.updated_at).toBeTypeOf('string')
    }

    // A follow-up reactivates the session: it moves to the top of the list.
    await sseOf(await completions(cookie, { session_id: firstId, query: 'Follow up?' }))
    const again = (await (await app.request('/chat/sessions', { headers: cookieHeader(cookie) })).json()) as WireList
    expect(again.items.map((s) => s.title)).toEqual(['First session', 'Second session'])
  })

  it('a second user sees only their own sessions', async () => {
    const alice = await activeMemberCookie()
    await sseOf(await completions(alice, { query: 'Alice private' }))

    const bob = await activeMemberCookie(OTHER.email)
    const res = await app.request('/chat/sessions', { headers: cookieHeader(bob) })
    const body = (await res.json()) as WireList
    expect(body).toEqual({ items: [], total: 0, page: 1, page_size: 20 })
  })

  it('paginates and validates query params', async () => {
    const cookie = await activeMemberCookie()
    for (const title of ['One', 'Two', 'Three']) {
      await sseOf(await completions(cookie, { query: title }))
    }
    const page1 = (await (await app.request('/chat/sessions?page=1&page_size=2', { headers: cookieHeader(cookie) })).json()) as WireList
    expect(page1.items.map((s) => s.title)).toEqual(['Three', 'Two'])
    expect(page1.total).toBe(3)
    const page2 = (await (await app.request('/chat/sessions?page=2&page_size=2', { headers: cookieHeader(cookie) })).json()) as WireList
    expect(page2.items.map((s) => s.title)).toEqual(['One'])

    const bad = await app.request('/chat/sessions?page_size=0', { headers: cookieHeader(cookie) })
    expect(bad.status).toBe(400)
  })

  it('requires a session', async () => {
    const res = await app.request('/chat/sessions')
    expect(res.status).toBe(401)
  })
})
