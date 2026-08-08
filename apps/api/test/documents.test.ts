import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../src/auth/jwt.js'
import { documents, users } from '../src/db/schema.js'
import type { DB } from '../src/db/client.js'
import { MAX_UPLOAD_BYTES } from '../src/ragflow/files.js'
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
  stub.failUploads = false
  stub.failDownloads = false
})

const USER = { email: 'member@example.com', password: 'correct-horse' }

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
}

interface WireList {
  items: WireDocument[]
  total: number
  page: number
  page_size: number
  counts: Record<string, number>
}

interface WireHistoryEntry {
  from_status: string | null
  to_status: string
  note: string | null
  actor: { id: string; name: string }
  created_at: string
}

interface WireError {
  error: { code: string; message: string; fields?: Record<string, string[]> }
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function signIn(): Promise<string> {
  const res = await app.request('/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(USER),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const value = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  if (value === undefined) throw new Error('sign-in failed: no session cookie')
  return value
}

/** Creates an active member directly and returns a session cookie. */
async function memberCookie(): Promise<string> {
  await app.request('/auth/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace', email: USER.email, password: USER.password }),
  })
  await db.update(users).set({ status: 'active' }).where(eq(users.email, USER.email))
  return await signIn()
}

function uploadForm(filename: string, content: string, mimeType = 'text/plain'): FormData {
  const form = new FormData()
  form.append('file', new Blob([content], { type: mimeType }), filename)
  return form
}

async function upload(cookie: string, filename: string, content: string): Promise<Response> {
  return await app.request('/documents', {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    body: uploadForm(filename, content),
  })
}

const cookieHeader = (cookie: string): { cookie: string } => ({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('POST /documents', () => {
  it('uploads a supported file as a draft, stored unparsed in RagFlow', async () => {
    const cookie = await memberCookie()
    const content = '# Hello\n\nKnowledge base notes.\n'
    const res = await upload(cookie, 'notes.md', content)
    expect(res.status).toBe(201)
    const { document } = await jsonOf<{ document: WireDocument }>(res)
    expect(document).toMatchObject({
      name: 'notes.md',
      ext: 'md',
      size_bytes: Buffer.byteLength(content),
      status: 'draft',
      chunk_count: 0,
      chunk_method: 'naive',
      retries_left: 3,
      owner: { name: 'Ada Lovelace' },
    })
    expect(document.published_at).toBeUndefined()
    expect(document.id).toBeTypeOf('string')

    expect(stub.uploads).toHaveLength(1)
    expect(stub.uploads[0]?.name).toBe('notes.md')
    expect(stub.uploads[0]?.content.toString()).toBe(content)
    expect(stub.uploads[0]?.run).toBe('UNSTART')
    expect(stub.uploads[0]?.chunkCount).toBe(0)

    const [row] = await db.select().from(documents).where(eq(documents.name, 'notes.md')).limit(1)
    expect(row).toBeDefined()
    expect(row?.ragflowDocumentId).toBe(stub.uploads[0]?.id)
    expect(row?.ownerId).toBeTypeOf('string')
  })

  it('derives chunk_method: pptx→presentation, png→picture, mp3→audio, txt→naive', async () => {
    const cookie = await memberCookie()
    const cases: Array<[string, string]> = [
      ['deck.pptx', 'presentation'],
      ['photo.png', 'picture'],
      ['audio.mp3', 'audio'],
      ['plain.txt', 'naive'],
    ]
    for (const [filename, expected] of cases) {
      const res = await upload(cookie, filename, 'x')
      expect(res.status).toBe(201)
      const { document } = await jsonOf<{ document: WireDocument }>(res)
      expect(document.chunk_method).toBe(expected)
    }
    expect(stub.uploads).toHaveLength(4)
  })

  it('rejects an unsupported suffix with 400 validation_error and fields', async () => {
    const cookie = await memberCookie()
    const res = await upload(cookie, 'virus.exe', 'MZ')
    expect(res.status).toBe(400)
    const { error } = await jsonOf<WireError>(res)
    expect(error.code).toBe('validation_error')
    expect(error.fields?.['file']).toContain('Unsupported file type .exe')
    expect(stub.uploads).toHaveLength(0)
  })

  it('rejects a file name over 255 bytes with 400 and name fields', async () => {
    const cookie = await memberCookie()
    const res = await upload(cookie, `${'a'.repeat(256)}.md`, 'x')
    expect(res.status).toBe(400)
    const { error } = await jsonOf<WireError>(res)
    expect(error.code).toBe('validation_error')
    expect(error.fields?.['name']).toBeDefined()
    expect(stub.uploads).toHaveLength(0)
  })

  it('rejects an upload over 1 GiB with 413 payload_too_large', async () => {
    const cookie = await memberCookie()
    const oversized = new Request('http://local/documents', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=abc',
        'content-length': String(MAX_UPLOAD_BYTES + 1),
        ...cookieHeader(cookie),
      },
      body: 'tiny',
    })
    const res = await app.request(oversized)
    expect(res.status).toBe(413)
    expect((await jsonOf<WireError>(res)).error.code).toBe('payload_too_large')
    expect(stub.uploads).toHaveLength(0)
  })

  it('returns 502 upstream_error when RagFlow fails', async () => {
    const cookie = await memberCookie()
    stub.failUploads = true
    const res = await upload(cookie, 'notes.md', 'x')
    expect(res.status).toBe(502)
    expect((await jsonOf<WireError>(res)).error.code).toBe('upstream_error')
  })

  it('requires a session', async () => {
    const res = await app.request('/documents', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=abc' },
      body: 'x',
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /documents', () => {
  it('lists documents with pagination shape, counts, and the wire document shape', async () => {
    const cookie = await memberCookie()
    await upload(cookie, 'one.md', 'a')
    await upload(cookie, 'two.pdf', 'b')
    await db.update(documents).set({ status: 'published' }).where(eq(documents.name, 'two.pdf'))
    const res = await app.request('/documents', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    const body = await jsonOf<WireList>(res)
    expect(body).toMatchObject({ total: 2, page: 1, page_size: 20 })
    // Corpus-wide counts, unaffected by filters
    expect(body.counts).toEqual({ draft: 1, ready: 0, publishing: 0, published: 1, failed: 0 })
    expect(body.items).toHaveLength(2)
    const byName = new Map(body.items.map((item) => [item.name, item]))
    expect(byName.get('one.md')).toMatchObject({ status: 'draft', owner: { name: 'Ada Lovelace' } })
    expect(byName.get('two.pdf')).toMatchObject({ status: 'published', owner: { name: 'Ada Lovelace' } })
    for (const item of body.items) {
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('ext')
      expect(item).toHaveProperty('size_bytes')
      expect(item).toHaveProperty('progress')
      expect(item).toHaveProperty('chunk_count')
      expect(item).toHaveProperty('chunk_method')
      expect(item).toHaveProperty('retries_left')
      expect(item).toHaveProperty('created_at')
      expect(item).toHaveProperty('updated_at')
    }
  })

  it('filters by status, owner_id, and q; sorts by updated_at desc by default', async () => {
    const cookie = await memberCookie()
    await upload(cookie, 'first.md', 'a')
    await sleep(10)
    await upload(cookie, 'second.md', 'b')
    await sleep(10)
    await upload(cookie, 'report.pdf', 'c')
    await db.update(documents).set({ status: 'ready' }).where(eq(documents.name, 'report.pdf'))

    const byStatus = await jsonOf<WireList>(
      await app.request('/documents?status=ready', { headers: cookieHeader(cookie) }),
    )
    expect(byStatus.total).toBe(1)
    expect(byStatus.items[0]?.name).toBe('report.pdf')

    const byOwner = await jsonOf<WireList>(
      await app.request(`/documents?owner_id=${encodeURIComponent(byStatus.items[0]?.owner.id ?? '')}`, {
        headers: cookieHeader(cookie),
      }),
    )
    expect(byOwner.total).toBe(3)

    const byQ = await jsonOf<WireList>(await app.request('/documents?q=report', { headers: cookieHeader(cookie) }))
    expect(byQ.total).toBe(1)
    expect(byQ.items[0]?.name).toBe('report.pdf')

    const sorted = await jsonOf<WireList>(
      await app.request('/documents?sort=updated_at_desc', { headers: cookieHeader(cookie) }),
    )
    expect(sorted.items.map((d) => d.name)).toEqual(['report.pdf', 'second.md', 'first.md'])
  })

  it('paginates', async () => {
    const cookie = await memberCookie()
    for (let i = 0; i < 3; i += 1) {
      await upload(cookie, `doc-${i}.md`, 'x')
      await sleep(5)
    }
    const page1 = await jsonOf<WireList>(await app.request('/documents?page=1&page_size=2', { headers: cookieHeader(cookie) }))
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(3)
    const page2 = await jsonOf<WireList>(await app.request('/documents?page=2&page_size=2', { headers: cookieHeader(cookie) }))
    expect(page2.items).toHaveLength(1)
    expect(page2.page).toBe(2)
  })

  it('validates query params', async () => {
    const cookie = await memberCookie()
    const bad = await app.request('/documents?status=banana', { headers: cookieHeader(cookie) })
    expect(bad.status).toBe(400)
    expect((await jsonOf<WireError>(bad)).error.code).toBe('validation_error')
    const badSize = await app.request('/documents?page_size=0', { headers: cookieHeader(cookie) })
    expect(badSize.status).toBe(400)
  })

  it('requires a session', async () => {
    const res = await app.request('/documents')
    expect(res.status).toBe(401)
  })
})

describe('GET /documents/:id', () => {
  it('returns detail with history', async () => {
    const cookie = await memberCookie()
    const created = await jsonOf<{ document: WireDocument }>(await upload(cookie, 'notes.md', 'x'))
    const id = created.document.id
    const res = await app.request(`/documents/${id}`, { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ document: WireDocument; history: WireHistoryEntry[] }>(res)
    expect(body.document.name).toBe('notes.md')
    expect(body.history).toHaveLength(1)
    expect(body.history[0]).toMatchObject({
      from_status: null,
      to_status: 'draft',
      note: 'Uploaded',
      actor: { name: 'Ada Lovelace' },
    })
    expect(body.history[0]?.created_at).toBeTypeOf('string')
  })

  it('returns 404 for an unknown document', async () => {
    const cookie = await memberCookie()
    const res = await app.request('/documents/00000000-0000-0000-0000-000000000000', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(404)
    expect((await jsonOf<WireError>(res)).error.code).toBe('not_found')
  })

  it('returns 404 (not 500) for a non-uuid id', async () => {
    const cookie = await memberCookie()
    const res = await app.request('/documents/not-a-uuid', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(404)
    expect((await jsonOf<WireError>(res)).error.code).toBe('not_found')
  })

  it('requires a session', async () => {
    const res = await app.request('/documents/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(401)
  })
})

describe('GET /documents/:id/download', () => {
  it('returns the original file with attachment disposition in draft status', async () => {
    const cookie = await memberCookie()
    const content = '# Draft notes\n'
    const created = await jsonOf<{ document: WireDocument }>(await upload(cookie, 'notes.md', content))
    const res = await app.request(`/documents/${created.document.id}/download`, { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="notes.md"')
    expect(await res.text()).toBe(content)
  })

  it('works in any status', async () => {
    const cookie = await memberCookie()
    const created = await jsonOf<{ document: WireDocument }>(await upload(cookie, 'notes.md', 'x'))
    await db.update(documents).set({ status: 'published' }).where(eq(documents.id, created.document.id))
    const res = await app.request(`/documents/${created.document.id}/download`, { headers: cookieHeader(cookie) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('x')
  })

  it('returns 404 for an unknown document', async () => {
    const cookie = await memberCookie()
    const res = await app.request('/documents/00000000-0000-0000-0000-000000000000/download', {
      headers: cookieHeader(cookie),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 (not 500) for a non-uuid id', async () => {
    const cookie = await memberCookie()
    const res = await app.request('/documents/not-a-uuid/download', { headers: cookieHeader(cookie) })
    expect(res.status).toBe(404)
  })

  it('returns 502 when RagFlow no longer has the file', async () => {
    const cookie = await memberCookie()
    const created = await jsonOf<{ document: WireDocument }>(await upload(cookie, 'notes.md', 'x'))
    stub.uploads.length = 0 // the file disappears from RagFlow
    const res = await app.request(`/documents/${created.document.id}/download`, { headers: cookieHeader(cookie) })
    expect(res.status).toBe(502)
    expect((await jsonOf<WireError>(res)).error.code).toBe('upstream_error')
  })
})
