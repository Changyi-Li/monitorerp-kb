import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Config } from '../config.js'
import { sanitizeFilename } from './files.js'

export class RagflowError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/**
 * Parses an upstream JSON response; an unparseable body (empty, HTML proxy
 * page) is an upstream failure, not a crash: it surfaces as RagflowError so
 * the routes map it to 502, never a 500.
 */
export const parseUpstreamJson = async (upstream: Response): Promise<unknown> => {
  try {
    return await upstream.json()
  } catch {
    throw new RagflowError('RagFlow returned an unparseable payload')
  }
}

/**
 * RagFlow reports rejections as HTTP 200 with a non-zero `code` in the body
 * (issue #14); a swallowed rejection makes the app pretend an upstream write
 * succeeded. Throws RagflowError unless the payload reports code 0.
 */
export const expectCodeZero = async (upstream: Response, rejected: string): Promise<void> => {
  const payload = (await parseUpstreamJson(upstream)) as { code?: number }
  if (payload.code !== 0) {
    throw new RagflowError(rejected)
  }
}

/**
 * Wraps a fetch so network failures surface as RagflowError instead of raw
 * TypeErrors (DNS/network failures would otherwise crash route handlers with
 * a 500 instead of the upstream 502 envelope).
 */
export const guardedFetch = async (url: URL, init: RequestInit, authHeader: string): Promise<Response> => {
  try {
    return await fetch(url, { ...init, headers: { authorization: authHeader, ...init.headers } })
  } catch (err) {
    throw new RagflowError(`RagFlow unreachable: ${(err as Error).message}`)
  }
}

export interface RagflowUploadInput {
  stream: NodeJS.ReadableStream
  filename: string
  mimeType: string
}

export interface RagflowUploadResult {
  documentId: string
  chunkCount: number
}

export interface RagflowDocumentState {
  id: string
  run: string
  progress: number
  chunkCount: number
  progressMsg: string | null
  chunkMethod: string
}

export interface RagflowClient {
  uploadDocument(input: RagflowUploadInput): Promise<RagflowUploadResult>
  listDocuments(): Promise<RagflowDocumentState[]>
  downloadDocument(documentId: string): Promise<Response>
  setChunkMethod(documentId: string, chunkMethod: string): Promise<void>
  triggerParse(documentId: string): Promise<void>
  deleteDocument(documentId: string): Promise<void>
  getDataset(): Promise<{ name: string }>
}

interface RagflowDocumentPayload {
  code?: number
  // Real RagFlow v0.26.4 returns `data` as an array of documents, even for a
  // single-file upload (issue #13).
  data?: Array<{ id?: string; name?: string; size?: number; chunk_count?: number; run?: string }>
}

interface RagflowDatasetPayload {
  code?: number
  data?: { name?: string }
}

interface RagflowListItemPayload {
  code?: number
  // Real RagFlow v0.26.4 returns `data` as `{ docs: [...], total: n }` from
  // the list endpoint (issue #14), NOT a bare array.
  data?: {
    docs?: Array<{
      id?: string
      run?: string
      progress?: number
      chunk_count?: number
      progress_msg?: string
      chunk_method?: string
    }>
    total?: number
  }
}

/**
 * HTTP client for a self-hosted RagFlow instance. RagFlow is the file store:
 * an upload creates the document unparsed (`run: UNSTART`) and parsing only
 * starts on publish. The dataset is fixed at deployment (the app never
 * manages datasets), so the client captures it.
 */
export function createRagflowClient(config: Config): RagflowClient {
  const base = new URL(config.ragflowUrl)
  const authHeader = `Bearer ${config.ragflowApiKey}`
  const documentsUrl = () => new URL(`/api/v1/datasets/${config.ragflowDatasetId}/documents`, base)
  const documentUrl = (documentId: string) =>
    new URL(`/api/v1/datasets/${config.ragflowDatasetId}/documents/${documentId}`, base)
  const chunksUrl = () => new URL(`/api/v1/datasets/${config.ragflowDatasetId}/chunks`, base)

  return {
    async uploadDocument({ stream, filename, mimeType }) {
      const boundary = `----monitorerp-${randomBytes(16).toString('hex')}`
      // The file is re-streamed as a fresh multipart body; never buffered.
      const prelude = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeFilename(filename)}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      const epilogue = `\r\n--${boundary}--\r\n`
      const body = new PassThrough()
      body.write(prelude)
      stream.pipe(body, { end: false })
      stream.on('end', () => {
        body.write(epilogue)
        body.end()
      })

      const upstream = await guardedFetch(
        documentsUrl(),
        {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: body as unknown as NonNullable<RequestInit['body']>,
          duplex: 'half',
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow upload failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await parseUpstreamJson(upstream)) as RagflowDocumentPayload
      if (payload.code !== 0 || payload.data?.[0]?.id === undefined) {
        throw new RagflowError('RagFlow returned an error payload')
      }
      return {
        documentId: payload.data[0].id,
        chunkCount: payload.data[0].chunk_count ?? 0,
      }
    },

    async listDocuments() {
      const upstream = await guardedFetch(documentsUrl(), { method: 'GET' }, authHeader)
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow list failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await parseUpstreamJson(upstream)) as RagflowListItemPayload
      // An unusable payload is an upstream failure, not a crash: it must
      // surface as RagflowError so the routes map it to 502, never a 500.
      if (payload.code !== 0 || payload.data == null || !Array.isArray(payload.data.docs)) {
        throw new RagflowError('RagFlow returned an error payload')
      }
      return payload.data.docs
        .filter((item) => item.id !== undefined)
        .map((item) => ({
          id: item.id as string,
          run: item.run ?? 'UNSTART',
          progress: item.progress ?? 0,
          chunkCount: item.chunk_count ?? 0,
          progressMsg: item.progress_msg ?? null,
          chunkMethod: item.chunk_method ?? 'naive',
        }))
    },

    async downloadDocument(documentId) {
      return await guardedFetch(documentUrl(documentId), { method: 'GET' }, authHeader)
    },

    // A chunk_method PUT resets the document: parse data purged, file kept.
    async setChunkMethod(documentId, chunkMethod) {
      const upstream = await guardedFetch(
        documentUrl(documentId),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chunk_method: chunkMethod }),
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow chunk method update failed with status ${upstream.status}`, upstream.status)
      }
      await expectCodeZero(upstream, 'RagFlow chunk method update was rejected')
    },

    async triggerParse(documentId) {
      const upstream = await guardedFetch(
        chunksUrl(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Real RagFlow's parse endpoint takes `document_ids` (plural, array)
          // in the JSON body, NOT a `document_id` query param (issue #14).
          body: JSON.stringify({ document_ids: [documentId] }),
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow parse trigger failed with status ${upstream.status}`, upstream.status)
      }
      // Without the code check a rejected trigger silently "succeeds" and the
      // doc lands in publishing with no parse running (issue #14).
      await expectCodeZero(upstream, 'RagFlow parse trigger was rejected')
    },

    async deleteDocument(documentId) {
      // Real RagFlow deletes via the collection endpoint with `ids` in the
      // JSON body; DELETE on the single-document path answers 405 (verified
      // live while fixing issue #14).
      const upstream = await guardedFetch(
        documentsUrl(),
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [documentId] }),
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow delete failed with status ${upstream.status}`, upstream.status)
      }
      await expectCodeZero(upstream, 'RagFlow delete was rejected')
    },

    async getDataset() {
      // The display name the web shell shows (issue #40): read from RagFlow
      // at runtime, never baked into a client bundle. Real RagFlow v0.26.4
      // returns `data` as the dataset object with `name`.
      const upstream = await guardedFetch(
        new URL(`/api/v1/datasets/${config.ragflowDatasetId}`, base),
        { method: 'GET' },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow dataset fetch failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await parseUpstreamJson(upstream)) as RagflowDatasetPayload
      if (payload.code !== 0 || typeof payload.data?.name !== 'string') {
        throw new RagflowError('RagFlow returned an error payload')
      }
      return { name: payload.data.name }
    },
  }
}
