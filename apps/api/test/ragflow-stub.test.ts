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
