import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Config } from '../config.js'
import { sanitizeFilename } from './files.js'

export class RagflowError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
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
}

interface RagflowDocumentPayload {
  code?: number
  data?: { id?: string; name?: string; size?: number; chunk_count?: number; run?: string }
}

interface RagflowListItemPayload {
  code?: number
  data?: Array<{
    id?: string
    run?: string
    progress?: number
    chunk_count?: number
    progress_msg?: string
    chunk_method?: string
  }>
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

  /** Wraps a fetch so network failures surface as RagflowError. */
  const guardedFetch = async (url: URL, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, { ...init, headers: { authorization: authHeader, ...init.headers } })
    } catch (err) {
      throw new RagflowError(`RagFlow unreachable: ${(err as Error).message}`)
    }
  }

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

      const upstream = await guardedFetch(documentsUrl(), {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: body as unknown as NonNullable<RequestInit['body']>,
        duplex: 'half',
      })
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow upload failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await upstream.json()) as RagflowDocumentPayload
      if (payload.code !== 0 || payload.data?.id === undefined) {
        throw new RagflowError('RagFlow returned an error payload')
      }
      return {
        documentId: payload.data.id,
        chunkCount: payload.data.chunk_count ?? 0,
      }
    },

    async listDocuments() {
      const upstream = await guardedFetch(documentsUrl(), { method: 'GET' })
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow list failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await upstream.json()) as RagflowListItemPayload
      if (payload.code !== 0 || payload.data === undefined) {
        throw new RagflowError('RagFlow returned an error payload')
      }
      return payload.data
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
      return await guardedFetch(documentUrl(documentId), { method: 'GET' })
    },

    // A chunk_method PUT resets the document: parse data purged, file kept.
    async setChunkMethod(documentId, chunkMethod) {
      const upstream = await guardedFetch(documentUrl(documentId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chunk_method: chunkMethod }),
      })
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow chunk method update failed with status ${upstream.status}`, upstream.status)
      }
    },

    async triggerParse(documentId) {
      const url = chunksUrl()
      url.searchParams.set('document_id', documentId)
      const upstream = await guardedFetch(url, { method: 'POST' })
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow parse trigger failed with status ${upstream.status}`, upstream.status)
      }
    },

    async deleteDocument(documentId) {
      const upstream = await guardedFetch(documentUrl(documentId), { method: 'DELETE' })
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow delete failed with status ${upstream.status}`, upstream.status)
      }
    },
  }
}
