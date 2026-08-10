import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentClient } from '../src/ragflow/agent.js'
import { RagflowError } from '../src/ragflow/client.js'
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

/** Static HTTP server that records requests and answers 200 with `payload.current`. */
async function startPayloadServer(): Promise<PayloadServer> {
  const payload: { current: unknown } = { current: {} }
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

// Pins the agent client's completion wire contract against the agent API
// surface (research #20): POST /api/v1/agents/chat/completions with
// `{agent_id, query, stream: true}` and `session_id` OMITTED for lazy
// auto-create (sending a null session_id would create a session named
// "None" upstream).
describe('RagFlow agent client — completion wire contract', () => {
  let server: PayloadServer
  let url: string

  beforeAll(async () => {
    server = await startPayloadServer()
    url = server.url
  })

  afterAll(async () => {
    await server.close()
  })

  it('sends agent_id, query, stream:true and no session_id when null (lazy create)', async () => {
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await client.completions({ sessionId: null, query: 'What is the leave policy?' })
    const req = server.requests.at(-1)
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe('/api/v1/agents/chat/completions')
    expect(req?.contentType).toContain('application/json')
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      agent_id: 'dev-agent',
      query: 'What is the leave policy?',
      stream: true,
    })
  })

  it('sends session_id when resuming an existing session', async () => {
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await client.completions({ sessionId: 'ragflow-session-42', query: 'Follow up?' })
    const req = server.requests.at(-1)
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      agent_id: 'dev-agent',
      query: 'Follow up?',
      stream: true,
      session_id: 'ragflow-session-42',
    })
  })

  it('returns the upstream Response for the caller to consume the SSE stream', async () => {
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    const upstream = await client.completions({ sessionId: null, query: 'hi' })
    expect(upstream.ok).toBe(true)
  })

  it('throws RagflowError when upstream answers non-2xx', async () => {
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: 'http://127.0.0.1:1' })
    await expect(client.completions({ sessionId: null, query: 'hi' })).rejects.toBeInstanceOf(RagflowError)
  })
})

// Pins the session fetch/delete wire contracts (research #20): GET one
// session with `?id=&dsl=false` (always dsl=false — the DSL payload balloons
// to ~2 MB), DELETE with `{ids, delete_all}` in the JSON body.
describe('RagFlow agent client — session wire contracts', () => {
  let server: PayloadServer
  let url: string

  beforeAll(async () => {
    server = await startPayloadServer()
    url = server.url
  })

  afterAll(async () => {
    await server.close()
  })

  it('fetchSession requests the session by id with dsl=false and returns the payload data', async () => {
    server.payload.current = { code: 0, data: { id: 's-1', message: [{ role: 'user', content: 'hi' }] } }
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    const session = await client.fetchSession('s-1')
    const req = server.requests.at(-1)
    expect(req?.method).toBe('GET')
    expect(req?.url).toContain('/api/v1/agents/dev-agent/sessions')
    expect(req?.url).toContain('id=s-1')
    expect(req?.url).toContain('dsl=false')
    expect(session).toEqual({ id: 's-1', message: [{ role: 'user', content: 'hi' }] })
  })

  it('fetchSession throws RagflowError when RagFlow rejects the session', async () => {
    server.payload.current = { code: 102, message: 'session not found' }
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.fetchSession('s-1')).rejects.toBeInstanceOf(RagflowError)
  })

  it('fetchSession throws RagflowError when the payload is not JSON', async () => {
    server.payload.current = '<html>proxy error</html>'
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.fetchSession('s-1')).rejects.toBeInstanceOf(RagflowError)
  })

  it('deleteSession sends ids and delete_all in the JSON body', async () => {
    server.payload.current = { code: 0 }
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await client.deleteSession('s-1')
    const req = server.requests.at(-1)
    expect(req?.method).toBe('DELETE')
    expect(req?.url).toBe('/api/v1/agents/dev-agent/sessions')
    expect(req?.contentType).toContain('application/json')
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ ids: ['s-1'], delete_all: false })
  })

  it('deleteSession throws RagflowError when RagFlow rejects with a non-zero code', async () => {
    server.payload.current = { code: 102, message: 'session not found' }
    const client = createAgentClient({ ...TEST_CONFIG, ragflowUrl: url })
    await expect(client.deleteSession('s-1')).rejects.toBeInstanceOf(RagflowError)
  })
})
