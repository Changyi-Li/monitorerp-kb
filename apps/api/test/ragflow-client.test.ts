import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RagflowError, createRagflowClient } from '../src/ragflow/client.js'
import { TEST_CONFIG } from './helpers.js'

interface RecordedRequest {
  method: string
  url: string
  body: string
  contentType: string | null
}

interface PayloadServer {
  url: string
  payload: { current: unknown }
  requests: RecordedRequest[]
  close: () => Promise<void>
}

/**
 * Static HTTP server that answers every request with `payload.current` and
 * records the requests, so tests can pin both the client's wire format and
 * how it reacts to the payload RagFlow returns.
 */
async function startPayloadServer(): Promise<PayloadServer> {
  const payload: { current: unknown } = { current: undefined }
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'] ?? null,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(typeof payload.current === 'string' ? payload.current : JSON.stringify(payload.current))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    payload,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()))
      }),
  }
}

// Pins the client's list parsing to the wire shape of real RagFlow v0.26.4:
// `data` is `{ docs: [...], total: n }` (verified live while diagnosing
// issue #14). The old bare-array assumption threw TypeError at the route
// boundary → 500 `internal`; the contract is 502 `upstream_error`, so any
// unusable payload must surface as RagflowError, never crash the parser.
describe('RagFlow client — listDocuments wire shape', () => {
  // Fixture captured from the live RagFlow list endpoint (issue #14).
  const REAL_SHAPE = {
    code: 0,
    data: {
      docs: [
        {
          id: '26687478939411f181a2493b86811cba',
          name: 'filler.txt',
          run: 'UNSTART',
          progress: 0,
          chunk_count: 0,
          progress_msg: '',
          chunk_method: 'naive',
        },
      ],
      total: 1,
    },
  }

  let server: PayloadServer
  let url: string

  beforeAll(async () => {
    server = await startPayloadServer()
    url = server.url
  })

  afterAll(async () => {
    await server.close()
  })

  it('parses the real list response shape into document states', async () => {
    server.payload.current = REAL_SHAPE
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    const docs = await client.listDocuments()
    expect(docs).toEqual([
      {
        id: '26687478939411f181a2493b86811cba',
        run: 'UNSTART',
        progress: 0,
        chunkCount: 0,
        progressMsg: '',
        chunkMethod: 'naive',
      },
    ])
  })

  it('returns an empty list for an empty dataset', async () => {
    server.payload.current = { code: 0, data: { docs: [], total: 0 } }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    expect(await client.listDocuments()).toEqual([])
  })

  it('throws RagflowError when docs is missing, not TypeError', async () => {
    server.payload.current = { code: 0, data: { total: 0 } }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when data is the old bare-array shape', async () => {
    server.payload.current = { code: 0, data: [{ id: 'doc-1', run: 'UNSTART' }] }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when data is null, not TypeError', async () => {
    server.payload.current = { code: 0, data: null }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when the body is not JSON', async () => {
    server.payload.current = '<html>proxy error</html>'
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })
})

// Pins the write endpoints' contracts against real RagFlow v0.26.4
// (verified live while fixing issue #14): `document_ids`/`ids` (plural,
// arrays) in JSON bodies — NOT `document_id` query params or id-in-path —
// and rejections reported as HTTP 200 with a non-zero `code` in the body.
// The old formats were silently swallowed and the operations never took
// effect (the parse never started, the file was never deleted).
describe('RagFlow client — write endpoint wire contracts', () => {
  let server: PayloadServer
  let url: string

  beforeAll(async () => {
    server = await startPayloadServer()
    url = server.url
  })

  afterAll(async () => {
    await server.close()
  })

  it('triggerParse sends document_ids (plural) in the JSON body', async () => {
    server.payload.current = { code: 0 }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await client.triggerParse('doc-1')
    const req = server.requests.at(-1)
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe('/api/v1/datasets/dev-dataset/chunks')
    expect(req?.url).not.toContain('document_id=')
    expect(req?.contentType).toContain('application/json')
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ document_ids: ['doc-1'] })
  })

  it('triggerParse throws RagflowError when RagFlow rejects with code 102', async () => {
    server.payload.current = { code: 102, message: '`document_ids` is required' }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.triggerParse('doc-1')).rejects.toBeInstanceOf(RagflowError)
  })

  it('triggerParse throws RagflowError when the rejection body is not JSON', async () => {
    server.payload.current = '<html>proxy error</html>'
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.triggerParse('doc-1')).rejects.toBeInstanceOf(RagflowError)
  })

  it('setChunkMethod throws RagflowError when RagFlow rejects with a non-zero code', async () => {
    server.payload.current = { code: 102, message: 'document not found' }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.setChunkMethod('doc-1', 'naive')).rejects.toBeInstanceOf(RagflowError)
  })

  it('deleteDocument sends ids (plural) in the JSON body to the collection endpoint', async () => {
    server.payload.current = { code: 0 }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await client.deleteDocument('doc-1')
    const req = server.requests.at(-1)
    expect(req?.method).toBe('DELETE')
    expect(req?.url).toBe('/api/v1/datasets/dev-dataset/documents')
    expect(req?.contentType).toContain('application/json')
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ ids: ['doc-1'] })
  })

  it('deleteDocument throws RagflowError when RagFlow rejects with a non-zero code', async () => {
    server.payload.current = { code: 102, message: 'document not found' }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.deleteDocument('doc-1')).rejects.toBeInstanceOf(RagflowError)
  })
})
