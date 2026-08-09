import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import { hashPassword } from '../src/auth/passwords.js'
import type { DB } from '../src/db/client.js'
import { documentHistory, documents, users } from '../src/db/schema.js'
import { sweeperTick } from '../src/sweeper.js'
import { createRagflowClient } from '../src/ragflow/client.js'
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
  stub.uploads.length = 0
  stub.chunkMethodCalls.length = 0
  stub.parseTriggers.length = 0
  stub.failUploads = false
  stub.failDownloads = false
  stub.failDeletes = false
  stub.failParse = false
  stub.failChunkMethodPut = false
  stub.failList = false
})

const MEMBER = { email: 'member@example.com', password: 'correct-horse' }
const OTHER = { email: 'other@example.com', password: 'correct-horse' }

interface WireDocument {
  id: string
  name: string
  ext: string
  size_bytes: number
  status: string
  owner: { id: string; name: string }
  progress: number
  chunk_count: number
  chunk_method: string
  retries_left: number
  created_at: string
  updated_at: string
  published_at?: string
  last_error?: string | null
}

interface WireHistoryEntry {
  id: string
  actor: { id: string; name: string } | null
  from_status: string | null
  to_status: string
  note: string | null
  created_at: string
}

interface WireDetail {
  document: WireDocument
  history: WireHistoryEntry[]
}

interface WireError {
  error: { code: string; message: string }
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

const cookieHeader = (cookie: string): { cookie: string } => ({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` })

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const value = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  if (value === undefined) throw new Error(`sign-in failed for ${email}`)
  return value
}

/** Creates an active member directly and returns their session cookie. */
async function memberCookie(email = MEMBER.email): Promise<string> {
  const res = await app.request('/auth/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: email.split('@')[0], email, password: 'correct-horse' }),
  })
  expect(res.status).toBe(201)
  await db.update(users).set({ status: 'active' }).where(eq(users.email, email))
  return await signIn(email, 'correct-horse')
}

async function adminCookie(): Promise<string> {
  const [existing] = await db.select().from(users).where(eq(users.email, TEST_CONFIG.adminEmail)).limit(1)
  if (existing === undefined) {
    // Direct insert — seedSuperAdmin only seeds an empty table.
    await db.insert(users).values({
      name: TEST_CONFIG.adminName,
      email: TEST_CONFIG.adminEmail,
      passwordHash: await hashPassword(TEST_CONFIG.adminPassword),
      role: 'super_admin',
      status: 'active',
    })
  }
  return await signIn(TEST_CONFIG.adminEmail, TEST_CONFIG.adminPassword)
}

async function upload(cookie: string, filename = 'notes.md', content = '# notes\n'): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/plain' }), filename)
  const res = await app.request('/documents', {
    method: 'POST',
    headers: cookieHeader(cookie),
    body: form,
  })
  expect(res.status).toBe(201)
  const { document } = await jsonOf<{ document: WireDocument }>(res)
  return document.id
}

const post = async (cookie: string, path: string): Promise<Response> =>
  await app.request(path, { method: 'POST', headers: cookieHeader(cookie) })

const act = (cookie: string, action: string, id: string): Promise<Response> =>
  post(cookie, `/documents/${id}/${action}`)

async function detail(id: string, cookie: string): Promise<WireDetail> {
  return await jsonOf<WireDetail>(await app.request(`/documents/${id}`, { headers: cookieHeader(cookie) }))
}

type DocumentStatusValue = (typeof documents.$inferSelect)['status']

async function setStatus(id: string, status: DocumentStatusValue): Promise<void> {
  await db.update(documents).set({ status }).where(eq(documents.id, id))
}

describe('publish (owner or super admin)', () => {
  it('publishes a draft document: triggers the parse, moves to publishing', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    const res = await act(cookie, 'publish', id)
    expect(res.status).toBe(200)
    const { document } = await jsonOf<{ document: WireDocument }>(res)
    expect(document.status).toBe('publishing')
    expect(stub.parseTriggers).toContain(stub.uploads[0]?.id)
    const body = await detail(id, cookie)
    expect(body.history.at(-1)).toMatchObject({ from_status: 'draft', to_status: 'publishing', note: 'Published' })
  })

  it('no longer has a mark-ready endpoint (404)', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    expect((await act(cookie, 'mark-ready', id)).status).toBe(404)
  })

  it('lets a super admin publish anyone draft document', async () => {
    const owner = await memberCookie()
    const id = await upload(owner)
    const admin = await adminCookie()
    const res = await act(admin, 'publish', id)
    expect(res.status).toBe(200)
    expect((await jsonOf<{ document: WireDocument }>(res)).document.status).toBe('publishing')
  })

  it('forbids a non-owner member', async () => {
    const owner = await memberCookie()
    const id = await upload(owner)
    const other = await memberCookie(OTHER.email)
    const res = await act(other, 'publish', id)
    expect(res.status).toBe(403)
  })

  it('rejects non-draft documents with 409 wrong_status', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await setStatus(id, 'publishing')
    const res = await act(cookie, 'publish', id)
    expect(res.status).toBe(409)
    expect((await jsonOf<WireError>(res)).error.code).toBe('wrong_status')
  })

  it('restores the stored chunk method before triggering the parse when RagFlow drifted', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    stub.setChunkMethodState(stub.uploads[0]?.id ?? '', 'picture') // drifted from stored 'naive'
    const res = await act(cookie, 'publish', id)
    expect(res.status).toBe(200)
    expect(stub.chunkMethodCalls).toEqual([{ documentId: stub.uploads[0]?.id, method: 'naive' }])
    expect(stub.parseTriggers).toContain(stub.uploads[0]?.id)
  })

  it('skips the chunk-method PUT when RagFlow already matches', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    const res = await act(cookie, 'publish', id)
    expect(res.status).toBe(200)
    expect(stub.chunkMethodCalls).toHaveLength(0)
    expect(stub.parseTriggers).toHaveLength(1)
  })

  it('returns 502 and stays draft when RagFlow fails', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    stub.failParse = true
    const res = await act(cookie, 'publish', id)
    expect(res.status).toBe(502)
    expect((await jsonOf<WireError>(res)).error.code).toBe('upstream_error')
    const body = await detail(id, cookie)
    expect(body.document.status).toBe('draft')
    expect(body.history.at(-1)?.to_status).toBe('draft')
  })
})

describe('sweeper', () => {
  async function publishingDoc(): Promise<{ id: string; cookie: string }> {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    return { id, cookie }
  }

  it('DONE settles the document as published with chunk_count and history', async () => {
    const { id, cookie } = await publishingDoc()
    const ragflowId = stub.uploads[0]?.id ?? ''
    stub.setRun(ragflowId, 'DONE')
    stub.setProgress(ragflowId, 1)
    if (stub.uploads[0] !== undefined) stub.uploads[0].chunkCount = 5

    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))

    const body = await detail(id, cookie)
    expect(body.document.status).toBe('published')
    expect(body.document.chunk_count).toBe(5)
    expect(body.document.published_at).toBeTypeOf('string')
    expect(body.document.progress).toBe(100)
    expect(body.history.at(-1)).toMatchObject({
      from_status: 'publishing',
      to_status: 'published',
      note: 'Parse completed',
      actor: null, // system transition
    })
  })

  it('FAIL and CANCEL settle the document as failed with the last error', async () => {
    const cookie = await memberCookie()
    for (const [run, expectedNote] of [
      ['FAIL', 'Parse failed'],
      ['CANCEL', 'Parse cancelled'],
    ] as const) {
      const id = await upload(cookie)
      await act(cookie, 'publish', id)
      const ragflowId = stub.parseTriggers.at(-1) ?? ''
      stub.setRun(ragflowId, run)
      stub.setProgressMsg(ragflowId, 'boom')
      await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
      const body = await detail(id, cookie)
      expect(body.document.status).toBe('failed')
      expect(body.document.last_error).toBe('boom')
      expect(body.history.at(-1)).toMatchObject({ from_status: 'publishing', to_status: 'failed', note: expectedNote })
    }
  })

  it('a document missing from RagFlow settles as failed with a note', async () => {
    const { id, cookie } = await publishingDoc()
    stub.uploads.length = 0
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    const body = await detail(id, cookie)
    expect(body.document.status).toBe('failed')
    expect(body.document.last_error).toBe('Removed in RagFlow')
  })

  it('RUNNING and UNSTART keep the document publishing and refresh progress', async () => {
    const cookie = await memberCookie()
    for (const [run, progress, expected] of [
      ['RUNNING', 0.5, 50],
      ['UNSTART', 0.12, 12],
    ] as const) {
      const id = await upload(cookie)
      await act(cookie, 'publish', id)
      const ragflowId = stub.parseTriggers.at(-1) ?? ''
      stub.setRun(ragflowId, run)
      stub.setProgress(ragflowId, progress)
      await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
      const body = await detail(id, cookie)
      expect(body.document.status).toBe('publishing')
      expect(body.document.progress).toBe(expected)
      expect(body.history).toHaveLength(2) // upload + publish — no new row
    }
  })

  it('a successful retry clears the last error', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    const ragflowId = stub.parseTriggers.at(-1) ?? ''
    stub.setRun(ragflowId, 'FAIL')
    stub.setProgressMsg(ragflowId, 'boom')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    expect((await detail(id, cookie)).document.last_error).toBe('boom')

    await act(cookie, 'retry', id)
    stub.setRun(ragflowId, 'DONE')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))

    const body = await detail(id, cookie)
    expect(body.document.status).toBe('published')
    expect(body.document.last_error).toBeNull()
  })

  it('skips the tick when RagFlow is unreachable', async () => {
    const { id, cookie } = await publishingDoc()
    stub.failList = true
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    const body = await detail(id, cookie)
    expect(body.document.status).toBe('publishing')
  })
})

describe('retry (owner or super admin)', () => {
  async function failedDoc(): Promise<{ id: string; cookie: string }> {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    stub.setRun(stub.uploads[0]?.id ?? '', 'FAIL')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    return { id, cookie }
  }

  it('retries a failed document: increments retry_count, triggers the parse', async () => {
    const { id, cookie } = await failedDoc()
    const res = await act(cookie, 'retry', id)
    expect(res.status).toBe(200)
    const { document } = await jsonOf<{ document: WireDocument }>(res)
    expect(document.status).toBe('publishing')
    expect(document.retries_left).toBe(2)
    expect(stub.parseTriggers.length).toBe(2)
    const body = await detail(id, cookie)
    expect(body.history.at(-1)).toMatchObject({ from_status: 'failed', to_status: 'publishing', note: 'Retry 1' })
  })

  it('answers 409 retries_exhausted after three retries', async () => {
    const { id, cookie } = await failedDoc()
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ok = await act(cookie, 'retry', id)
      expect(ok.status).toBe(200)
      stub.setRun(stub.uploads[0]?.id ?? '', 'FAIL')
      await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    }
    const res = await act(cookie, 'retry', id)
    expect(res.status).toBe(409)
    expect((await jsonOf<WireError>(res)).error.code).toBe('retries_exhausted')
  })

  it('an exhausted document recovers: withdraw → re-publish completes', async () => {
    const { id, cookie } = await failedDoc()
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await act(cookie, 'retry', id)
      stub.setRun(stub.uploads[0]?.id ?? '', 'FAIL')
      await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    }
    const exhausted = await act(cookie, 'retry', id)
    expect(exhausted.status).toBe(409)

    expect((await act(cookie, 'withdraw', id)).status).toBe(200)
    expect((await act(cookie, 'publish', id)).status).toBe(200)
    stub.setRun(stub.parseTriggers.at(-1) ?? '', 'DONE')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))

    const body = await detail(id, cookie)
    expect(body.document.status).toBe('published')
    expect(body.document.retries_left).toBe(3)
    expect(body.history.map((h) => `${h.from_status}→${h.to_status}`)).toEqual([
      'null→draft',
      'draft→publishing',
      'publishing→failed',
      'failed→publishing',
      'publishing→failed',
      'failed→publishing',
      'publishing→failed',
      'failed→publishing',
      'publishing→failed',
      'failed→draft',
      'draft→publishing',
      'publishing→published',
    ])
  })

  it('forbids a non-owner member; a super admin can retry any failed document', async () => {
    const { id } = await failedDoc()
    const other = await memberCookie(OTHER.email)
    expect((await act(other, 'retry', id)).status).toBe(403)
    const admin = await adminCookie()
    expect((await act(admin, 'retry', id)).status).toBe(200)
  })

  it('rejects non-failed documents with 409 wrong_status', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    const res = await act(cookie, 'retry', id)
    expect(res.status).toBe(409)
  })
})

describe('withdraw (owner or super admin)', () => {
  async function publishedDoc(): Promise<{ id: string; cookie: string }> {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    stub.setRun(stub.uploads[0]?.id ?? '', 'DONE')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    return { id, cookie }
  }

  it('withdraws a published document: parser flip, file kept, counters reset', async () => {
    const { id, cookie } = await publishedDoc()
    const ragflowId = stub.uploads[0]?.id ?? ''
    const res = await act(cookie, 'withdraw', id)
    expect(res.status).toBe(200)
    const { document } = await jsonOf<{ document: WireDocument }>(res)
    expect(document.status).toBe('draft')
    expect(document.chunk_count).toBe(0)
    expect(document.retries_left).toBe(3)
    expect(document.published_at).toBeUndefined()
    // Parser flip: PUT with a different chunk method; the file is kept.
    expect(stub.chunkMethodCalls.at(-1)).toMatchObject({ documentId: ragflowId, method: 'picture' })
    expect(stub.uploads[0]?.run).toBe('UNSTART')
    expect(stub.uploads[0]?.content.length).toBeGreaterThan(0)
    const download = await app.request(`/documents/${id}/download`, { headers: cookieHeader(cookie) })
    expect(download.status).toBe(200)
    const body = await detail(id, cookie)
    expect(body.history.at(-1)).toMatchObject({ from_status: 'published', to_status: 'draft', note: 'Withdrawn' })
  })

  it('chooses a flip method that differs from RagFlow\'s current method, even under drift', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    stub.setRun(stub.parseTriggers.at(-1) ?? '', 'DONE')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    // RagFlow drifted to the default flip target ('picture') — a naive flip would no-op.
    const ragflowId = stub.uploads[0]?.id ?? ''
    stub.setChunkMethodState(ragflowId, 'picture')
    const res = await act(cookie, 'withdraw', id)
    expect(res.status).toBe(200)
    expect(stub.chunkMethodCalls.at(-1)?.method).toBe('naive')
    expect(stub.uploads[0]?.run).toBe('UNSTART')
  })

  it('withdraws a failed document too', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await act(cookie, 'publish', id)
    stub.setRun(stub.uploads[0]?.id ?? '', 'FAIL')
    await sweeperTick(db, createRagflowClient({ ...TEST_CONFIG, ragflowUrl: stub.url }))
    const res = await act(cookie, 'withdraw', id)
    expect(res.status).toBe(200)
    expect((await jsonOf<{ document: WireDocument }>(res)).document.status).toBe('draft')
  })

  it('rejects draft and publishing documents with 409 wrong_status', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    expect((await act(cookie, 'withdraw', id)).status).toBe(409)
    await act(cookie, 'publish', id) // now publishing, still RUNNING in the stub
    expect((await act(cookie, 'withdraw', id)).status).toBe(409)
  })

  it('forbids a non-owner member; a super admin can withdraw any published document', async () => {
    const { id } = await publishedDoc()
    const other = await memberCookie(OTHER.email)
    expect((await act(other, 'withdraw', id)).status).toBe(403)
    const admin = await adminCookie()
    expect((await act(admin, 'withdraw', id)).status).toBe(200)
  })
})

describe('delete (owner or super admin)', () => {
  it('deletes the RagFlow document first, then the row and its history', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    const ragflowId = stub.uploads[0]?.id ?? ''
    const res = await app.request(`/documents/${id}`, { method: 'DELETE', headers: cookieHeader(cookie) })
    expect(res.status).toBe(204)
    expect(stub.uploads).toHaveLength(0)
    const rows = await db.select().from(documents).where(eq(documents.id, id))
    expect(rows).toHaveLength(0)
    const history = await db.select().from(documentHistory).where(eq(documentHistory.documentId, id))
    expect(history).toHaveLength(0)
    void ragflowId
  })

  it('lets a super admin delete any document; forbids non-owner members', async () => {
    const owner = await memberCookie()
    const id = await upload(owner)
    const other = await memberCookie(OTHER.email)
    expect((await app.request(`/documents/${id}`, { method: 'DELETE', headers: cookieHeader(other) })).status).toBe(403)
    const admin = await adminCookie()
    expect((await app.request(`/documents/${id}`, { method: 'DELETE', headers: cookieHeader(admin) })).status).toBe(204)
  })

  it('answers 409 publishing while a document is being parsed', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    await setStatus(id, 'publishing')
    const res = await app.request(`/documents/${id}`, { method: 'DELETE', headers: cookieHeader(cookie) })
    expect(res.status).toBe(409)
    expect((await jsonOf<WireError>(res)).error.code).toBe('publishing')
  })

  it('returns 502 and keeps the row when the RagFlow delete fails', async () => {
    const cookie = await memberCookie()
    const id = await upload(cookie)
    stub.failDeletes = true
    const res = await app.request(`/documents/${id}`, { method: 'DELETE', headers: cookieHeader(cookie) })
    expect(res.status).toBe(502)
    const rows = await db.select().from(documents).where(eq(documents.id, id))
    expect(rows).toHaveLength(1)
  })
})
