import { afterAll, describe, expect, it } from 'vitest'
import { COMPLETION_DONE, listPayload, okPayload, rejectionPayload, uploadPayload } from '../ragflow-wire.js'
import {
  completionStream,
  deleteDocuments,
  deleteSession,
  fetchSession,
  listDocsOf,
  listDocuments,
  triggerParse,
  uploadDocument,
} from './ragflow-http.js'

// Stage (c) of the RagFlow release gate (spec #28 / ticket #35): direct HTTP
// probes of the LIVE instance asserting the stub's scripted wire expectations
// — the shared ragflow-wire.ts module both sides consume, so the fake and its
// audit cannot drift apart. The parse trigger is verified up to RUNNING and
// never waited out: RUNNING and DONE share the response shape, so a single
// list call verifies the wire for a fraction of the cost of a real parse
// (which the contract stage runs).
//
// Runs via `npm run gate:revalidation` against the real instance — test
// dataset + test agent in place (readme, "Release gate"). The stage fails
// loudly in global setup when the env vars are missing or the instance is
// unreachable.

const TEST_FILE_NAME = 'stub-revalidation.md'
const TEST_FILE_CONTENT = '# Stub revalidation probe\n\nA tiny document used by the stage-(c) wire audit.\n'
const UNKNOWN_DOCUMENT_ID = 'stub-revalidation-nonexistent-document'

/** Splits a raw SSE body into its `data:` lines — the frame shape the
 * expectations table documents: every frame is a single `data:` line. */
const parseSseDataLines = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('stage (c): stub revalidation against the real RagFlow instance', () => {
  // State threaded through the ordered probes (upload → list → parse →
  // stream → sessions → delete). A retried probe may create extras; cleanup
  // tracks every id this run saw.
  let uploadedDocumentId: string | undefined
  let streamedSessionId: string | undefined
  const createdDocumentIds: string[] = []
  const createdSessionIds: string[] = []

  afterAll(async () => {
    // Best-effort cleanup of what THIS run created; a cleanup failure never
    // reddens the stage (spec #28 — orphaned sessions are tolerated, RagFlow
    // has no session-list API to sweep them).
    for (const id of createdDocumentIds) {
      try {
        await deleteDocuments([id])
      } catch (err) {
        console.warn(`[revalidation] cleanup: deleting document ${id} failed — ${(err as Error).message}`)
      }
    }
    for (const id of createdSessionIds) {
      try {
        await deleteSession(id)
      } catch (err) {
        console.warn(`[revalidation] cleanup: deleting session ${id} failed — ${(err as Error).message}`)
      }
    }
  })

  it('upload: data is an array of documents, even for one file', async () => {
    const { status, payload } = await uploadDocument(TEST_FILE_NAME, TEST_FILE_CONTENT)
    expect(status).toBe(200)
    // The table's upload row: `data` is an ARRAY (issue #13), never a bare object.
    expect(payload).toMatchObject(uploadPayload([{ id: expect.any(String), name: TEST_FILE_NAME }]))
    const doc = (payload['data'] as Array<{ id?: string }>)[0]
    expect(doc?.id).toBeTypeOf('string')
    uploadedDocumentId = doc?.id
    if (uploadedDocumentId !== undefined) createdDocumentIds.push(uploadedDocumentId)
  })

  it('list: data is an object with docs/total and carries the upload', async () => {
    if (uploadedDocumentId === undefined) throw new Error('the upload probe must have run first')
    const { status, payload } = await listDocuments()
    expect(status).toBe(200)
    // The table's list row: `data` is an OBJECT with `docs`/`total` (issue
    // #14), never a bare array.
    expect(payload).toMatchObject(listPayload(expect.any(Array) as unknown[], expect.any(Number)))
    expect(listDocsOf(payload).map((doc) => doc.id)).toContain(uploadedDocumentId)
  })

  it('parse trigger: document_ids in the JSON body, run leaves UNSTART — never waited out', async () => {
    if (uploadedDocumentId === undefined) throw new Error('the upload probe must have run first')
    const { status, payload } = await triggerParse([uploadedDocumentId])
    expect(status).toBe(200)
    expect(payload).toMatchObject(okPayload({ chunk_count: expect.any(Number) }))

    // Stopped at RUNNING — never waited out: RUNNING and DONE share the
    // response shape. The trigger queues a parse task, so a short poll loop
    // watches the run leave UNSTART (task pickup is not instant) and stops at
    // the FIRST RUNNING/DONE observation. The real parse to DONE with
    // chunk_count > 0 is the contract stage's (a+) job.
    let run: string | undefined
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const listed = await listDocuments()
      run = listDocsOf(listed.payload).find((doc) => doc.id === uploadedDocumentId)?.run
      if (run === 'RUNNING' || run === 'DONE' || run === 'FAILED') break
      await sleep(2000)
    }
    expect(run).toMatch(/^(RUNNING|DONE)$/)
  })

  it('parse trigger rejection: HTTP 200 + non-zero code, never 4xx/5xx', async () => {
    const { status, payload } = await triggerParse([UNKNOWN_DOCUMENT_ID])
    expect(status).toBe(200)
    // The table's rejection row: rejections arrive as HTTP 200 with a non-zero
    // `code` (issue #14) — a 4xx/5xx here is a wire change.
    expect(payload).toMatchObject(rejectionPayload(expect.any(Number), expect.any(String)))
    expect(payload['code']).not.toBe(0)
  })

  it('completion stream: top-level session_id, no code field, ends [DONE]', async () => {
    const { status, headers, body } = await completionStream('Hello — stage (c) revalidation probe.')
    expect(status).toBe(200)
    expect(headers.get('content-type')).toContain('text/event-stream')

    const dataLines = parseSseDataLines(body)
    // The stream terminator — the shared token COMPLETION_DONE_FRAME frames.
    expect(dataLines.at(-1)).toBe(COMPLETION_DONE)
    const frames = dataLines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(frames.length).toBeGreaterThan(1)

    const sessionIds = new Set<string>()
    for (const frame of frames) {
      // Bug #29's exact divergence: success frames carry NO `code` field, and
      // session_id sits at the TOP LEVEL of every frame.
      expect('code' in frame).toBe(false)
      expect(frame['event']).toBeTypeOf('string')
      expect(frame['message_id']).toBeTypeOf('string')
      expect(frame['task_id']).toBeTypeOf('string')
      expect(frame['data']).toBeTypeOf('object')
      expect(frame['session_id']).toBeTypeOf('string')
      sessionIds.add(String(frame['session_id']))
    }
    expect(sessionIds.size).toBe(1)
    streamedSessionId = [...sessionIds][0]
    if (streamedSessionId !== undefined) createdSessionIds.push(streamedSessionId)

    // Message frames carry string content; message_end carries the reference
    // with its chunks map (issue #30/#32 shape).
    const messages = frames.filter((frame) => frame['event'] === 'message')
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(typeof (message['data'] as { content?: unknown }).content).toBe('string')
    }
    const messageEnd = frames.find((frame) => frame['event'] === 'message_end')
    expect(messageEnd).toBeDefined()
    const reference = (messageEnd?.['data'] as { reference?: { chunks?: Record<string, unknown> } } | undefined)?.reference
    expect(reference).toBeDefined()
    expect(Object.keys(reference?.['chunks'] ?? {}).length).toBeGreaterThan(0)
  })

  it('session get: data wraps the session in a one-element array with message history', async () => {
    if (streamedSessionId === undefined) throw new Error('the completion stream probe must have run first')
    const { status, payload } = await fetchSession(streamedSessionId)
    expect(status).toBe(200)
    // The table's session row: `data` wraps the session in a one-element
    // ARRAY (bug #29 family) with `message[]` history embedded.
    expect(payload).toMatchObject(okPayload([{ id: streamedSessionId }]))
    const sessions = (payload['data'] as Array<{ id?: unknown; message?: unknown }> | undefined) ?? []
    expect(Array.isArray(sessions)).toBe(true)
    expect(sessions[0]?.id).toBe(streamedSessionId)
    const messages = sessions[0]?.message
    expect(Array.isArray(messages)).toBe(true)
    expect((messages as unknown[]).length).toBeGreaterThanOrEqual(1)
  })

  it('session delete: ids + delete_all in the JSON body, code 0', async () => {
    if (streamedSessionId === undefined) throw new Error('the completion stream probe must have run first')
    const { status, payload } = await deleteSession(streamedSessionId)
    expect(status).toBe(200)
    expect(payload).toMatchObject(okPayload())
  })

  it('delete: ids in the collection body, code 0, doc gone from list', async () => {
    if (uploadedDocumentId === undefined) throw new Error('the upload probe must have run first')
    const { status, payload } = await deleteDocuments([uploadedDocumentId])
    expect(status).toBe(200)
    expect(payload).toMatchObject(okPayload())
    const listed = await listDocuments()
    expect(listDocsOf(listed.payload).map((doc) => doc.id)).not.toContain(uploadedDocumentId)
  })
})
