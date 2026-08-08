import { Busboy } from '@fastify/busboy'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StoredUpload {
  id: string
  name: string
  sizeBytes: number
  content: Buffer
  run: 'UNSTART'
  chunkCount: 0
}

export interface RagflowStub {
  url: string
  uploads: StoredUpload[]
  failUploads: boolean
  failDownloads: boolean
  close: () => Promise<void>
}

/**
 * In-process stand-in for the RagFlow HTTP API (per the testing decision:
 * "RagFlow is faked at the HTTP client boundary"). Implements upload
 * (creates an unparsed document) and document download. Mutable failure
 * flags let tests exercise the 502 paths.
 */
export async function startRagflowStub(): Promise<RagflowStub> {
  const uploads: StoredUpload[] = []
  const stub: RagflowStub = { url: '', uploads, failUploads: false, failDownloads: false, close: () => Promise.resolve() }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/documents(?:\/([^/]+))?$/)
    if (match === null) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 102, message: 'not found' }))
      return
    }
    const documentId = match[2]

    if (req.method === 'POST' && documentId === undefined) {
      if (stub.failUploads) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 101, message: 'simulated upstream failure' }))
        return
      }
      const parsed = await parseUpload(req)
      if (parsed === null) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 103, message: 'missing file' }))
        return
      }
      const stored: StoredUpload = {
        id: randomUUID(),
        name: parsed.name,
        sizeBytes: parsed.content.length,
        content: parsed.content,
        run: 'UNSTART',
        chunkCount: 0,
      }
      uploads.push(stored)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          code: 0,
          data: { id: stored.id, name: stored.name, size: stored.sizeBytes, chunk_count: 0, run: 'UNSTART' },
        }),
      )
      return
    }

    if (req.method === 'GET' && documentId !== undefined) {
      if (stub.failDownloads) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 101, message: 'simulated upstream failure' }))
        return
      }
      const stored = uploads.find((u) => u.id === documentId)
      if (stored === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 102, message: 'document not found' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(stored.content)
      return
    }

    if (req.method === 'DELETE' && documentId !== undefined) {
      const index = uploads.findIndex((u) => u.id === documentId)
      if (index === -1) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 102, message: 'document not found' }))
        return
      }
      uploads.splice(index, 1)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
      return
    }

    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 104, message: 'method not allowed' }))
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  stub.url = `http://127.0.0.1:${port}`
  stub.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined ? reject(err) : resolve()))
    })
  return stub
}
