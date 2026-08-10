import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRagflowStub, type RagflowStub } from './ragflow-stub.js'

// Pins the stub's upload response to the wire shape of real RagFlow v0.26.4:
// `data` is an ARRAY of documents even for a single-file upload. The client
// reads `data[0]` (issue #13); if the fixture ever regresses to a single
// object, this test goes red instead of silently masking a client bug.
describe('RagFlow stub — upload response wire shape', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('returns data as an array of documents', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x']), 'notes.md')
    const res = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`, {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { code: number; data?: unknown }
    expect(payload.code).toBe(0)
    expect(Array.isArray(payload.data)).toBe(true)
    const docs = payload.data as Array<{ id?: string; name?: string; chunk_count?: number }>
    expect(docs[0]).toMatchObject({ id: stub.uploads[0]?.id, name: 'notes.md', chunk_count: 0 })
  })
})

// Pins the stub's list response to the wire shape of real RagFlow v0.26.4:
// `data` is an OBJECT with `docs` / `total` (verified live while diagnosing
// issue #14), not a bare array. The client reads `data.docs`; if the fixture
// ever regresses, this test goes red instead of masking a client bug.
describe('RagFlow stub — list response wire shape', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('returns data as an object with docs and total', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x']), 'notes.md')
    await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`, {
      method: 'POST',
      body: form,
    })
    const res = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { code: number; data?: unknown }
    expect(payload.code).toBe(0)
    expect(Array.isArray(payload.data)).toBe(false)
    const data = payload.data as { docs?: unknown; total?: number }
    expect(data.total).toBe(1)
    expect(Array.isArray(data.docs)).toBe(true)
    const docs = data.docs as Array<{ id?: string; name?: string; run?: string }>
    expect(docs[0]).toMatchObject({ id: stub.uploads[0]?.id, name: 'notes.md', run: 'UNSTART' })
  })
})

// Pins the stub's parse-trigger contract to the wire shape of real RagFlow
// v0.26.4: POST /chunks takes `document_ids` (plural, array) in the JSON
// body and reports rejections as HTTP 200 with a non-zero `code` (verified
// live while diagnosing issue #14). The old `document_id` query-param
// format is rejected by the real API, so the stub must reject it too — a
// stub that accepts the wrong format masks the client bug.
describe('RagFlow stub — parse trigger wire contract', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('accepts document_ids in the JSON body and records the trigger', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x']), 'notes.md')
    const up = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`, {
      method: 'POST',
      body: form,
    })
    const upload = (await up.json()) as { data: Array<{ id: string }> }
    const id = upload.data[0]!.id
    const res = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/chunks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document_ids: [id] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { code: number }).toMatchObject({ code: 0 })
    expect(stub.parseTriggers).toContain(id)
  })

  it('rejects the old query-param format like the real API (200 + code 102)', async () => {
    const res = await fetch(
      `${stub.url}/api/v1/datasets/dev-dataset/chunks?document_id=whatever`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { code: number; message?: string }
    expect(body.code).toBe(102)
    expect(body.message).toContain('document_ids')
  })
})

// Pins the stub's agent completion SSE to the REAL wire shape (verified live
// on 2026-08-10, bug #29): single `data:` lines whose JSON is {event,
// message_id, task_id, data, session_id} — success frames carry NO `code`
// field, and session_id sits at the TOP LEVEL (the old `{code: 0, data:
// {session_id, content}}` envelope was the dataset API's and masked the bug).
// The proxy's transform consumes exactly this shape; a regression here would
// silently change what the transform sees.
describe('RagFlow stub — session fetch wire shape', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('returns data as a one-element array of session objects with message history', async () => {
    // Create a session through the completion endpoint first (auto-create).
    await fetch(`${stub.url}/api/v1/agents/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'dev-agent', query: 'hi', stream: true }),
    })
    const sessionId = stub.completionRequests[0]?.streamedSessionId
    expect(sessionId).toBeTypeOf('string')
    const res = await fetch(`${stub.url}/api/v1/agents/dev-agent/sessions?id=${sessionId}&dsl=false`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { code: number; data?: unknown }
    expect(payload.code).toBe(0)
    // REAL shape (bug #29 family): the session is wrapped in an ARRAY — the
    // old object shape made the client's unwrap dead code.
    expect(Array.isArray(payload.data)).toBe(true)
    const session = (payload.data as Array<{ id?: unknown; message?: unknown }>)[0]
    expect(session?.id).toBe(sessionId)
    expect(Array.isArray(session?.message)).toBe(true)
  })
})
describe('RagFlow stub — agent completion SSE wire shape', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('streams message frames with session_id and content, then [DONE]', async () => {
    const res = await fetch(`${stub.url}/api/v1/agents/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'dev-agent', query: 'hi', stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()

    const frames = body
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block !== '')
    expect(frames.at(-1)).toBe('data: [DONE]')

    const parse = (f: string): { event?: unknown; data?: { content?: unknown }; session_id?: unknown } =>
      JSON.parse(f.replace(/^data:/, ''))
    const jsonFrames = frames.filter((f) => f.startsWith('data:')).filter((f) => f !== 'data: [DONE]')
    const messageFrames = jsonFrames.map(parse).filter((p) => p.event === 'message')
    const messageEndFrames = jsonFrames.map(parse).filter((p) => p.event === 'message_end')
    expect(messageFrames.length).toBeGreaterThan(1)
    expect(messageEndFrames).toHaveLength(1)

    // Every frame carries the auto-created session id at the TOP LEVEL, and
    // success frames carry no `code` field (bug #29's exact divergence).
    const sessionIds = messageFrames.map((p) => {
      expect('code' in p).toBe(false)
      expect(typeof p.data?.content).toBe('string')
      return p.session_id
    })
    expect(new Set(sessionIds).size).toBe(1)
    const streamedSessionId = sessionIds[0]
    expect(streamedSessionId).toBeTypeOf('string')

    // The auto-created session is the one recorded in the request log.
    expect(stub.completionRequests[0]?.sessionId).toBeNull()
    expect(stub.completionRequests[0]?.streamedSessionId).toBe(streamedSessionId)
  })

  it('echoes a sent session id in every frame', async () => {
    const res = await fetch(`${stub.url}/api/v1/agents/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'dev-agent', query: 'hi', stream: true, session_id: 's-123' }),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    const first = body.split('\n\n')[0]
    if (first === undefined) throw new Error('no frames')
    const data = JSON.parse(first.replace(/^data:/, '')) as { session_id?: unknown }
    expect(data.session_id).toBe('s-123')
  })
})

// Pins the stub's delete contract to real RagFlow v0.26.4: DELETE on the
// collection endpoint with `ids` (plural, array) in the JSON body — DELETE
// on the single-document path answers 405 (verified live while fixing
// issue #14). A stub accepting the old path format masks a client bug.
describe('RagFlow stub — delete wire contract', () => {
  let stub: RagflowStub

  beforeAll(async () => {
    stub = await startRagflowStub()
  })

  afterAll(async () => {
    await stub.close()
  })

  it('accepts ids in the JSON body and removes the uploads', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x']), 'notes.md')
    const up = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`, {
      method: 'POST',
      body: form,
    })
    const upload = (await up.json()) as { data: Array<{ id: string }> }
    const id = upload.data[0]!.id
    const res = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { code: number }).toMatchObject({ code: 0 })
    expect(stub.uploads).toHaveLength(0)
  })

  it('rejects the old path-based DELETE like the real API (405)', async () => {
    const res = await fetch(`${stub.url}/api/v1/datasets/dev-dataset/documents/some-id`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(405)
  })
})
