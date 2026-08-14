import { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { createCompletionTransform, type ChatTransformEvent, type DocumentIdLookup } from '../../src/chat/transform.js'
import type { Config } from '../../src/config.js'
import { createAgentClient, type AgentClient } from '../../src/ragflow/agent.js'
import { createRagflowClient, RagflowError, type RagflowClient, type RagflowDocumentState } from '../../src/ragflow/client.js'
import { loadLiveEnv } from './env.js'
import { sleep, withInfraRetry } from './ragflow-http.js'

// Stage (a+) of the RagFlow release gate (spec #28 / ticket #36): drives the
// app's REAL RagFlow client and agent client against the live instance and
// asserts the client-side mappings and error handling. Real behaviors run to
// completion — a real parse is polled to DONE with chunk_count > 0, and a
// real completion stream is piped through the app's chat transform, so real
// parser semantics and real SSE framing — not the stub's scripted shapes —
// are verified. Same gate hygiene as stage (c): preflight wipe, one retry on
// infrastructure-style failures, best-effort cleanup, loud env gating.
//
// Runs via `npm run gate:contract` against the real instance — test dataset
// + test agent in place (readme, "Release gate").

// The probe file uses the stub's canonical reference document name, so the
// suite is also exercisable against the RagFlow stub (whose scripted
// citations are wired to that name, issue #25); on the real instance the name
// is inert — citations carry the uploaded document's real id.
const PROBE_NAME = 'Leave Policy.md'
const PROBE_CONTENT = `# Leave Policy

The leave policy grants 21 days of annual leave per calendar year.
It resets every January 1st.`
const PROBE_QUERY = 'How many days of annual leave does the leave policy grant per year?'

/** The synthetic "our documents.id" the injected citation→Document lookup
 * returns for the probe document — mirroring the route's DB-backed lookup. */
const OUR_DOCUMENT_ID = 'contract-our-document'

/** Splits a complete SSE body into frames on the blank-line separator, the
 * same way the chat route's sseFrames does for the byte stream. */
const splitSseFrames = (body: string): string[] =>
  body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame !== '')

/** Joins every answer delta — the [ID:n] marker hold splits some deltas. */
const answerText = (events: ChatTransformEvent[]): string =>
  events
    .filter((e): e is Extract<ChatTransformEvent, { type: 'answer' }> => e.type === 'answer')
    .map((e) => e.delta)
    .join('')

const liveEnv = loadLiveEnv()

// The clients read only the RagFlow fields — the rest are placeholders (this
// stage never touches Postgres or auth).
const config: Config = {
  databaseUrl: '',
  jwtSecret: '',
  adminEmail: '',
  adminPassword: '',
  adminName: '',
  ragflowUrl: liveEnv.ragflowUrl,
  ragflowApiKey: liveEnv.ragflowApiKey,
  ragflowDatasetId: liveEnv.ragflowDatasetId,
  ragflowAgentId: liveEnv.ragflowAgentId,
  pollIntervalMs: 0,
  port: 0,
}
const client: RagflowClient = createRagflowClient(config)
const agent: AgentClient = createAgentClient(config)

describe('stage (a+): contract tests against the real RagFlow instance', () => {
  // State threaded through the ordered probes. A retried probe may create
  // extras; cleanup tracks every id this run saw.
  let uploadedDocumentId: string | undefined
  let streamedSessionId: string | undefined
  const createdDocumentIds: string[] = []
  const createdSessionIds: string[] = []

  /** Guards an ordered probe that needs the upload; the returned id is
   * narrow-safe inside closures. */
  const requireDocumentId = (): string => {
    const id = uploadedDocumentId
    if (id === undefined) throw new Error('the upload probe must have run first')
    return id
  }

  /** Guards an ordered probe that needs the completion stream. */
  const requireSessionId = (): string => {
    const id = streamedSessionId
    if (id === undefined) throw new Error('the completion stream probe must have run first')
    return id
  }

  afterAll(async () => {
    // Best-effort cleanup of what THIS run created; a cleanup failure never
    // reddens the stage (spec #28 — orphaned sessions are tolerated).
    for (const id of createdDocumentIds) {
      try {
        await client.deleteDocument(id)
      } catch (err) {
        console.warn(`[gate] cleanup: deleting document ${id} failed — ${(err as Error).message}`)
      }
    }
    for (const id of createdSessionIds) {
      try {
        await agent.deleteSession(id)
      } catch (err) {
        console.warn(`[gate] cleanup: deleting session ${id} failed — ${(err as Error).message}`)
      }
    }
  })

  it('getDataset returns the live dataset display name (the web shell sidebar line, issue #40)', async () => {
    const { name } = await withInfraRetry('dataset fetch', () => client.getDataset())
    expect(name).toBeTypeOf('string')
    expect(name.trim().length).toBeGreaterThan(0)
  })

  it('upload maps the live response to {documentId, chunkCount}', async () => {
    const result = await withInfraRetry('upload', () =>
      client.uploadDocument({ stream: Readable.from([PROBE_CONTENT]), filename: PROBE_NAME, mimeType: 'text/markdown' }),
    )
    expect(result.documentId).toBeTypeOf('string')
    expect(result.chunkCount).toBe(0)
    uploadedDocumentId = result.documentId
    createdDocumentIds.push(uploadedDocumentId)
  })

  it('list maps the live response to document states', async () => {
    const documentId = requireDocumentId()
    const docs = await withInfraRetry('list documents', () => client.listDocuments())
    const doc = docs.find((d) => d.id === documentId)
    expect(doc).toBeDefined()
    expect(doc).toMatchObject({ id: uploadedDocumentId, run: 'UNSTART', chunkCount: 0 })
    expect(typeof doc?.progress).toBe('number')
    expect(typeof doc?.chunkMethod).toBe('string')
  })

  it('download returns the uploaded bytes byte-for-byte', async () => {
    const documentId = requireDocumentId()
    const bytes = await withInfraRetry('download', async () => {
      const res = await client.downloadDocument(documentId)
      if (!res.ok) throw new RagflowError(`download failed with status ${res.status}`, res.status)
      return Buffer.from(await res.arrayBuffer())
    })
    expect(bytes.equals(Buffer.from(PROBE_CONTENT))).toBe(true)
  })

  it('chunk-method flip: setChunkMethod, then list shows the new method', async () => {
    const documentId = requireDocumentId()
    await withInfraRetry('chunk method flip', () => client.setChunkMethod(documentId, 'naive'))
    const docs = await withInfraRetry('list after flip', () => client.listDocuments())
    const doc = docs.find((d) => d.id === documentId)
    // The flip purges parse data and resets the doc to UNSTART.
    expect(doc?.chunkMethod).toBe('naive')
    expect(doc?.run).toBe('UNSTART')
  })

  it('a real parse completes to DONE with chunk_count > 0 (polled, never scripted)', async () => {
    const documentId = requireDocumentId()
    await withInfraRetry('parse trigger', () => client.triggerParse(documentId))
    // Short poll interval under a generous multi-minute timeout: the real
    // parser and embedder run to completion here, so real parser semantics —
    // not scripted run transitions — are verified (spec #28, stage (a+)).
    // 60 × 3 s (plus list overhead) fits inside the live config's 300 s
    // testTimeout, so the loop's own verdict — not a vitest timeout — decides.
    let state: RagflowDocumentState | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const docs = await withInfraRetry('parse poll list', () => client.listDocuments())
      state = docs.find((d) => d.id === documentId)
      if (state?.run === 'DONE' || state?.run === 'FAILED') break
      await sleep(3000)
    }
    if (state?.run === 'FAILED') {
      throw new Error(`the real parse failed: ${state.progressMsg ?? '(no message from RagFlow)'}`)
    }
    expect(state?.run).toBe('DONE')
    expect(state?.chunkCount ?? 0).toBeGreaterThan(0)
  })

  it('a real completion stream survives the chat transform: answer, citations, no think tags', async () => {
    const documentId = requireDocumentId()
    const { response, body } = await withInfraRetry('completion stream', async () => {
      const response = await agent.completions({ sessionId: null, query: PROBE_QUERY })
      let body: string
      try {
        body = await response.text()
      } catch (err) {
        throw new RagflowError(`completion stream reset mid-body — ${(err as Error).message}`)
      }
      return { response, body }
    })
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    // The same injection the chat route performs: RagFlow document id → our
    // documents.id; only the probe document maps here.
    const documentIdLookup: DocumentIdLookup = (ragflowDocumentId: string): string | null =>
      ragflowDocumentId === documentId ? OUR_DOCUMENT_ID : null
    const transform = createCompletionTransform({ lazy: true, documentIdLookup })
    const events: ChatTransformEvent[] = []
    for (const frame of splitSseFrames(body)) {
      events.push(...transform.feed(frame))
    }

    // Lazy create: the leading session event carries the auto-created id.
    const sessionEvent = events.find((e): e is Extract<ChatTransformEvent, { type: 'session' }> => e.type === 'session')
    expect(sessionEvent).toBeDefined()
    streamedSessionId = sessionEvent?.id
    if (streamedSessionId !== undefined) createdSessionIds.push(streamedSessionId)

    // Event normalization: the stream completes with a non-empty answer, no
    // error event, and the terminal done.
    const answer = answerText(events)
    expect(answer).not.toBe('')
    // Think-tag stripping: reasoning arrives flag-gated (issue #32) and never
    // leaks <think> tags into the answer.
    expect(answer).not.toContain('<think')
    // Citation-marker normalization (issue #30): no raw [ID:n] markers survive.
    expect(answer).not.toContain('[ID:')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')

    // The terminal reference: the live chunks-object shape normalizes, and
    // every citation maps through the injected lookup. The probe document is
    // the only one in the (wiped) test dataset, so retrieval must cite it.
    const references = events.filter((e): e is Extract<ChatTransformEvent, { type: 'references' }> => e.type === 'references')
    expect(references).toHaveLength(1)
    const citations = references[0]?.items ?? []
    expect(citations.length).toBeGreaterThan(0)
    for (const item of citations) {
      expect(item.n).toBeGreaterThanOrEqual(1)
      expect(item.ragflow_document_id).toBeTypeOf('string')
      expect(item.document_name).toBeTypeOf('string')
      expect(item.document_id).toBe(item.ragflow_document_id === documentId ? OUR_DOCUMENT_ID : null)
    }
    expect(citations.some((item) => item.document_id === OUR_DOCUMENT_ID)).toBe(true)
  })

  it('session fetch round-trips the exchange against the live agent', async () => {
    const sessionId = requireSessionId()
    const session = await withInfraRetry('session fetch', () => agent.fetchSession(sessionId))
    const messages = session.message
    expect(Array.isArray(messages)).toBe(true)
    expect((messages as unknown[]).length).toBeGreaterThanOrEqual(2)
    const items = messages as Array<{ role?: unknown; content?: unknown }>
    expect(items.map((m) => m.role)).toEqual(expect.arrayContaining(['user', 'assistant']))
    // The user message is stored verbatim; the assistant message is stored in
    // full. (Whether it carries a <think> block is model behavior — the gate
    // never asserts on it, spec #28, user story 11.)
    expect(items[0]?.role).toBe('user')
    expect(items[0]?.content).toBe(PROBE_QUERY)
    const assistant = items.find((m) => m.role === 'assistant')
    expect(typeof assistant?.content).toBe('string')
  })

  it('session delete succeeds against the live agent', async () => {
    const sessionId = requireSessionId()
    await withInfraRetry('session delete', () => agent.deleteSession(sessionId))
  })

  // Deterministic rejection probes call the client directly — a rejection is
  // not infrastructure, so no retry (see withInfraRetry's contract).
  it('a code != 0 parse-trigger rejection maps to RagflowError (the 502 surface)', async () => {
    await expect(client.triggerParse('contract-nonexistent-document')).rejects.toBeInstanceOf(RagflowError)
  })

  it('a code != 0 session-fetch rejection maps to RagflowError (the 502 surface)', async () => {
    await expect(agent.fetchSession('contract-nonexistent-session')).rejects.toBeInstanceOf(RagflowError)
  })

  it('a code != 0 chunk-method rejection maps to RagflowError (the 502 surface)', async () => {
    await expect(client.setChunkMethod('contract-nonexistent-document', 'naive')).rejects.toBeInstanceOf(RagflowError)
  })

  it('delete removes the document from the live list', async () => {
    const documentId = requireDocumentId()
    await withInfraRetry('delete document', () => client.deleteDocument(documentId))
    const docs = await withInfraRetry('list after delete', () => client.listDocuments())
    expect(docs.map((d) => d.id)).not.toContain(documentId)
  })
})
