import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RagflowError, createRagflowClient } from '../src/ragflow/client.js'
import { TEST_CONFIG } from './helpers.js'

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

  let payload: unknown
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    url = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err !== undefined ? reject(err) : resolve())),
    )
  })

  it('parses the real list response shape into document states', async () => {
    payload = REAL_SHAPE
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
    payload = { code: 0, data: { docs: [], total: 0 } }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    expect(await client.listDocuments()).toEqual([])
  })

  it('throws RagflowError when docs is missing, not TypeError', async () => {
    payload = { code: 0, data: { total: 0 } }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when data is the old bare-array shape', async () => {
    payload = { code: 0, data: [{ id: 'doc-1', run: 'UNSTART' }] }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when data is null, not TypeError', async () => {
    payload = { code: 0, data: null }
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })

  it('throws RagflowError when the body is not JSON', async () => {
    payload = '<html>proxy error</html>'
    const client = createRagflowClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.listDocuments()).rejects.toBeInstanceOf(RagflowError)
  })
})
