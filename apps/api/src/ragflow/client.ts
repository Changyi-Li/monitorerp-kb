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

export interface RagflowClient {
  uploadDocument(input: RagflowUploadInput): Promise<RagflowUploadResult>
  downloadDocument(documentId: string): Promise<Response>
  deleteDocument(documentId: string): Promise<void>
}

interface RagflowDocumentPayload {
  code?: number
  data?: { id?: string; name?: string; size?: number; chunk_count?: number; run?: string }
}

/**
 * HTTP client for a self-hosted RagFlow instance. RagFlow is the file store:
 * an upload creates the document unparsed (`run: UNSTART`) and never queues
 * a parse — parsing only starts on publish (a later ticket). The dataset is
 * fixed at deployment (the app never manages datasets), so the client
 * captures it.
 */
export function createRagflowClient(config: Config): RagflowClient {
  const base = new URL(config.ragflowUrl)
  const authHeader = `Bearer ${config.ragflowApiKey}`
  const documentsUrl = () => new URL(`/api/v1/datasets/${config.ragflowDatasetId}/documents`, base)
  const documentUrl = (documentId: string) =>
    new URL(`/api/v1/datasets/${config.ragflowDatasetId}/documents/${documentId}`, base)

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

      let upstream: Response
      try {
        upstream = await fetch(documentsUrl(), {
          method: 'POST',
          headers: {
            authorization: authHeader,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          body: body as unknown as NonNullable<RequestInit['body']>,
          duplex: 'half',
        })
      } catch (err) {
        throw new RagflowError(`RagFlow unreachable: ${(err as Error).message}`)
      }
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

    async downloadDocument(documentId) {
      try {
        return await fetch(documentUrl(documentId), {
          headers: { authorization: authHeader },
        })
      } catch (err) {
        throw new RagflowError(`RagFlow unreachable: ${(err as Error).message}`)
      }
    },

    async deleteDocument(documentId) {
      let upstream: Response
      try {
        upstream = await fetch(documentUrl(documentId), {
          method: 'DELETE',
          headers: { authorization: authHeader },
        })
      } catch (err) {
        throw new RagflowError(`RagFlow unreachable: ${(err as Error).message}`)
      }
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow delete failed with status ${upstream.status}`, upstream.status)
      }
    },
  }
}
