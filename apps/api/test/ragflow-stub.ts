import { Busboy } from '@fastify/busboy'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StoredUpload {
  id: string
  name: string
  sizeBytes: number
  content: Buffer
  run: string
  chunkCount: number
  progress: number
  progressMsg: string | null
  chunkMethod: string
}

export interface ChunkMethodCall {
  documentId: string
  method: string
}

export interface StoredCompletion {
  agentId: string
  /** The session id the client sent — null means lazy auto-create. */
  sessionId: string | null
  query: string
  /** The session id carried in the stream (auto-created when the request sent none). */
  streamedSessionId: string
}

export interface RagflowStub {
  url: string
  uploads: StoredUpload[]
  chunkMethodCalls: ChunkMethodCall[]
  parseTriggers: string[]
  completionRequests: StoredCompletion[]
  failUploads: boolean
  failDownloads: boolean
  failDeletes: boolean
  failParse: boolean
  failChunkMethodPut: boolean
  failList: boolean
  failCompletions: boolean
  setRun: (id: string, run: string) => void
  setProgress: (id: string, progress: number) => void
  setProgressMsg: (id: string, message: string) => void
  setChunkMethodState: (id: string, method: string) => void
  close: () => Promise<void>
}

/**
 * In-process stand-in for the RagFlow HTTP API (per the testing decision:
 * "RagFlow is faked at the HTTP client boundary"). Implements upload (creates
 * an unparsed document), list (with run/progress state), download, the
 * chunk_method PUT (parser flip), the parse trigger, and delete. Tests drive
 * sweeper transitions by mutating the stub's run state, then assert through
 * the API.
 */
// The scripted agent completion stream: `<think>` tags SPLIT across deltas
// (the open tag is cut by the first frame boundary, the close tag by the
// last) so the API e2e proves the transform's tag handling end-to-end, a
// message_end with a live-shape reference the transform drops this slice,
// and the answer in word-level deltas so the web e2e can observe the answer
// streaming in incrementally.
const COMPLETION_DELTAS = [
  '<thi',
  'nk>The user asks about the leave policy. The policy states 21 days per year.\n</th',
  'ink>Leave',
  ' is capped',
  ' at 21 days',
  ' per year.',
  ' It resets',
  ' every',
  ' calendar year.',
]

const COMPLETION_REFERENCE = {
  chunks: {
    '1': {
      content: 'Leave is capped at 21 days per year.',
      document_id: 'stub-doc-1',
      document_name: 'Leave Policy.md',
      dataset_id: 'stub-dataset',
      positions: [[3, 0.1, 0.2, 0.8, 0.05]],
    },
  },
}

/** Small per-frame delay so the web e2e can observe the streaming state. */
const COMPLETION_FRAME_DELAY_MS = 30

export async function startRagflowStub(port = 0): Promise<RagflowStub> {
  const uploads: StoredUpload[] = []
  const chunkMethodCalls: ChunkMethodCall[] = []
  const parseTriggers: string[] = []
  const completionRequests: StoredCompletion[] = []
  const stub: RagflowStub = {
    url: '',
    uploads,
    chunkMethodCalls,
    parseTriggers,
    completionRequests,
    failUploads: false,
    failDownloads: false,
    failDeletes: false,
    failParse: false,
    failChunkMethodPut: false,
    failList: false,
    failCompletions: false,
    setRun: (id, run) => {
      const upload = uploads.find((u) => u.id === id)
      if (upload !== undefined) upload.run = run
    },
    setProgress: (id, progress) => {
      const upload = uploads.find((u) => u.id === id)
      if (upload !== undefined) upload.progress = progress
    },
    setProgressMsg: (id, message) => {
      const upload = uploads.find((u) => u.id === id)
      if (upload !== undefined) upload.progressMsg = message
    },
    setChunkMethodState: (id, method) => {
      const upload = uploads.find((u) => u.id === id)
      if (upload !== undefined) upload.chunkMethod = method
    },
    close: () => Promise.resolve(),
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunksMatch = url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/chunks$/)
    const docMatch = url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/documents(?:\/([^/]+))?$/)
    const fail = (code: number, message: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code, message }))
    }

    // Test observability: the recorded agent completion requests (used by the
    // web e2e, where the stub runs in its own process).
    if (url.pathname === '/__test/completions' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completionRequests))
      return
    }

    // Agent completion SSE (research #20 wire shape): POST
    // /api/v1/agents/chat/completions with `{agent_id, query, stream: true,
    // session_id?}`; when no session_id is sent, a session is auto-created
    // and its id is carried in every frame. The stream is scripted to include
    // <think> tags split across deltas and a message_end reference.
    if (url.pathname === '/api/v1/agents/chat/completions' && req.method === 'POST') {
      if (stub.failCompletions) return fail(500, 'simulated completion failure')
      const body = JSON.parse((await readBody(req)) || '{}') as {
        agent_id?: unknown
        query?: unknown
        stream?: unknown
        session_id?: unknown
      }
      if (typeof body.query !== 'string') return fail(400, 'query required')
      const agentId = typeof body.agent_id === 'string' ? body.agent_id : ''
      const sentSessionId = typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : null
      const streamedSessionId = sentSessionId ?? randomUUID()
      completionRequests.push({ agentId, sessionId: sentSessionId, query: body.query, streamedSessionId })

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const delta of COMPLETION_DELTAS) {
        res.write(`event: message\ndata: ${JSON.stringify({ code: 0, data: { session_id: streamedSessionId, content: delta } })}\n\n`)
        await sleep(COMPLETION_FRAME_DELAY_MS)
      }
      res.write(
        `event: message_end\ndata: ${JSON.stringify({
          code: 0,
          data: { session_id: streamedSessionId, reference: COMPLETION_REFERENCE },
        })}\n\n`,
      )
      res.write(`event: node_finished\ndata: ${JSON.stringify({ code: 0, data: {} })}\n\n`)
      res.write(`data: [DONE]\n\n`)
      res.end()
      return
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Test control: drive a document's run state by name (used by e2e, where
    // the ragflow document id is not exposed through the API).
    if (url.pathname === '/__test/run-by-name' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        name?: string
        run?: string
        progress?: number
        chunk_count?: number
        progress_msg?: string
      }
      const upload = uploads.find((u) => u.name === body.name)
      if (body.name === undefined || upload === undefined) return fail(404, 'document not found')
      if (body.run !== undefined) upload.run = body.run
      if (body.progress !== undefined) upload.progress = body.progress
      if (body.chunk_count !== undefined) upload.chunkCount = body.chunk_count
      if (body.progress_msg !== undefined) upload.progressMsg = body.progress_msg
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
      return
    }

    if (chunksMatch !== null && req.method === 'POST') {
      if (stub.failParse) return fail(500, 'simulated parse failure')
      // Real RagFlow v0.26.4 takes `document_ids` (plural, array) in the
      // JSON body and reports rejections as HTTP 200 + non-zero `code`
      // (verified live while diagnosing issue #14). The stub mirrors both,
      // so a client regressing to the old query-param format fails tests.
      const body = JSON.parse((await readBody(req)) || '{}') as { document_ids?: unknown }
      const ids = body.document_ids
      if (!Array.isArray(ids) || ids.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 102, message: '`document_ids` is required' }))
        return
      }
      const documentId = ids[0] as string
      if (!uploads.some((u) => u.id === documentId)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 102, message: `Documents not found: ['${documentId}']` }))
        return
      }
      parseTriggers.push(documentId)
      const upload = uploads.find((u) => u.id === documentId)
      if (upload !== undefined) {
        upload.run = 'RUNNING'
        upload.progress = 0
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { chunk_count: 0 } }))
      return
    }

    if (docMatch !== null && req.method === 'GET' && docMatch[2] === undefined) {
      if (stub.failList) return fail(500, 'simulated list failure')
      res.writeHead(200, { 'content-type': 'application/json' })
      // Real RagFlow v0.26.4 returns `data` as an OBJECT with `docs`/`total`
      // from the list endpoint (verified live while diagnosing issue #14) —
      // the stub must not mask that shape with a bare array.
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            docs: uploads.map((u) => ({
              id: u.id,
              name: u.name,
              run: u.run,
              progress: u.progress,
              chunk_count: u.chunkCount,
              progress_msg: u.progressMsg,
              chunk_method: u.chunkMethod,
            })),
            total: uploads.length,
          },
        }),
      )
      return
    }

    const documentId = docMatch?.[2]

    if (req.method === 'POST' && documentId === undefined) {
      if (stub.failUploads) return fail(500, 'simulated upstream failure')
      const parsed = await parseUpload(req)
      if (parsed === null) return fail(400, 'missing file')
      const stored: StoredUpload = {
        id: randomUUID(),
        name: parsed.name,
        sizeBytes: parsed.content.length,
        content: parsed.content,
        run: 'UNSTART',
        chunkCount: 0,
        progress: 0,
        progressMsg: null,
        chunkMethod: 'naive',
      }
      uploads.push(stored)
      res.writeHead(200, { 'content-type': 'application/json' })
      // Real RagFlow v0.26.4 returns `data` as an ARRAY of documents, even for
      // a single-file upload (verified live against the cloud instance while
      // investigating issue #13) — the stub must not mask that shape.
      res.end(
        JSON.stringify({
          code: 0,
          data: [{ id: stored.id, name: stored.name, size: stored.sizeBytes, chunk_count: 0, run: 'UNSTART' }],
        }),
      )
      return
    }

    if (req.method === 'PUT' && documentId !== undefined) {
      if (stub.failChunkMethodPut) return fail(500, 'simulated chunk method failure')
      const upload = uploads.find((u) => u.id === documentId)
      if (upload === undefined) return fail(404, 'document not found')
      const body = await readBody(req)
      const payload = JSON.parse(body) as { chunk_method?: string }
      const method = payload.chunk_method
      if (typeof method !== 'string') return fail(400, 'chunk_method required')
      chunkMethodCalls.push({ documentId, method })
      // Parser flip: the file is kept, parse data is purged.
      upload.chunkMethod = method
      upload.run = 'UNSTART'
      upload.chunkCount = 0
      upload.progress = 0
      upload.progressMsg = null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
      return
    }

    if (req.method === 'GET' && documentId !== undefined) {
      if (stub.failDownloads) return fail(500, 'simulated upstream failure')
      const stored = uploads.find((u) => u.id === documentId)
      if (stored === undefined) return fail(404, 'document not found')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(stored.content)
      return
    }

    // Real RagFlow deletes via the collection endpoint with `ids` in the
    // JSON body; DELETE on the single-document path answers 405 (verified
    // live while fixing issue #14) — that falls through to the 405 below.
    if (docMatch !== null && req.method === 'DELETE' && docMatch[2] === undefined) {
      if (stub.failDeletes) return fail(500, 'simulated delete failure')
      const body = JSON.parse((await readBody(req)) || '{}') as { ids?: unknown }
      const ids = body.ids
      if (!Array.isArray(ids) || ids.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 102, message: '`ids` is required' }))
        return
      }
      for (const id of ids) {
        const index = uploads.findIndex((u) => u.id === id)
        if (index !== -1) uploads.splice(index, 1)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
      return
    }

    return fail(405, 'method not allowed')
  }

  async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  async function parseUpload(req: import('node:http').IncomingMessage): Promise<{ name: string; content: Buffer } | null> {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.startsWith('multipart/form-data')) return null
    return await new Promise((resolve) => {
      const bb = Busboy({ headers: { 'content-type': contentType } })
      let name: string | undefined
      let content = Buffer.alloc(0)
      bb.on('file', (_field, stream, filename, _encoding, _mime) => {
        name = filename
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          content = Buffer.concat(chunks)
        })
      })
      bb.on('finish', () => resolve(name !== undefined ? { name, content } : null))
      bb.on('error', () => resolve(null))
      req.pipe(bb)
    })
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const { port: boundPort } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${boundPort}`
  stub.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined ? reject(err) : resolve()))
    })
  return stub
}
