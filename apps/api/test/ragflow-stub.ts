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

export interface RagflowStub {
  url: string
  uploads: StoredUpload[]
  chunkMethodCalls: ChunkMethodCall[]
  parseTriggers: string[]
  failUploads: boolean
  failDownloads: boolean
  failDeletes: boolean
  failParse: boolean
  failChunkMethodPut: boolean
  failList: boolean
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
export async function startRagflowStub(port = 0): Promise<RagflowStub> {
  const uploads: StoredUpload[] = []
  const chunkMethodCalls: ChunkMethodCall[] = []
  const parseTriggers: string[] = []
  const stub: RagflowStub = {
    url: '',
    uploads,
    chunkMethodCalls,
    parseTriggers,
    failUploads: false,
    failDownloads: false,
    failDeletes: false,
    failParse: false,
    failChunkMethodPut: false,
    failList: false,
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

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunksMatch = url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/chunks$/)
    const docMatch = url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/documents(?:\/([^/]+))?$/)
    const fail = (code: number, message: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code, message }))
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
      const documentId = url.searchParams.get('document_id')
      if (documentId === null || !uploads.some((u) => u.id === documentId)) return fail(404, 'document not found')
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

    if (req.method === 'DELETE' && documentId !== undefined) {
      if (stub.failDeletes) return fail(500, 'simulated delete failure')
      const index = uploads.findIndex((u) => u.id === documentId)
      if (index === -1) return fail(404, 'document not found')
      uploads.splice(index, 1)
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
