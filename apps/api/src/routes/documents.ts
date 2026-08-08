import { Busboy } from '@fastify/busboy'
import { and, asc, desc, eq, ilike, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { authMiddleware } from '../auth/middleware.js'
import type { User } from '../auth/user.js'
import type { DB } from '../db/client.js'
import { documentHistory, documents, users } from '../db/schema.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { RagflowError, type RagflowClient, type RagflowUploadInput, type RagflowUploadResult } from '../ragflow/client.js'
import {
  deriveChunkMethod,
  fileExtension,
  isSupportedSuffix,
  MAX_NAME_BYTES,
  MAX_UPLOAD_BYTES,
  sanitizeFilename,
  utf8ByteLength,
} from '../ragflow/files.js'
import { queryValidator } from '../validation.js'

const MAX_RETRIES = 3
const DEFAULT_PAGE_SIZE = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  status: z.enum(['draft', 'ready', 'publishing', 'published', 'failed']).optional(),
  owner_id: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(['updated_at_desc', 'updated_at_asc']).default('updated_at_desc'),
})

export type DocumentRow = typeof documents.$inferSelect

export interface DocumentShape {
  id: string
  name: string
  ext: string
  size_bytes: number
  status: DocumentRow['status']
  owner: { id: string; name: string }
  progress: number
  chunk_count: number
  chunk_method: string
  retries_left: number
  created_at: string
  updated_at: string
  published_at?: string
}

/** The wire shape for a document (issue #6 contract). */
export function documentShape(document: DocumentRow, ownerName: string): DocumentShape {
  return {
    id: document.id,
    name: document.name,
    ext: document.ext,
    size_bytes: document.sizeBytes,
    status: document.status,
    owner: { id: document.ownerId, name: ownerName },
    progress: document.progress,
    chunk_count: document.chunkCount,
    chunk_method: document.chunkMethod,
    retries_left: Math.max(0, MAX_RETRIES - document.retryCount),
    created_at: document.createdAt.toISOString(),
    updated_at: document.updatedAt.toISOString(),
    ...(document.publishedAt !== null ? { published_at: document.publishedAt.toISOString() } : {}),
  }
}

/** Escapes LIKE wildcards in a user-supplied search term. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** Returns the document row plus its owner's name, or undefined. */
async function findDocumentWithOwner(db: DB, id: string): Promise<
  | { document: DocumentRow; ownerName: string }
  | undefined
> {
  const [row] = await db
    .select({ document: documents, ownerName: users.name })
    .from(documents)
    .innerJoin(users, eq(documents.ownerId, users.id))
    .where(eq(documents.id, id))
    .limit(1)
  return row
}

export function documentsRoutes(deps: Deps) {
  const app = new Hono<{ Variables: { user: User } }>()
  app.use('*', authMiddleware(deps))
  const ragflow: RagflowClient = deps.ragflow

  // GET /documents?status=&owner_id=&q=&page=&page_size=&sort=
  app.get('/', queryValidator(listQuerySchema), async (c) => {
    const query = c.req.valid('query')
    const filters: SQL[] = []
    if (query.status !== undefined) filters.push(eq(documents.status, query.status))
    if (query.owner_id !== undefined) filters.push(eq(documents.ownerId, query.owner_id))
    if (query.q !== undefined && query.q !== '') filters.push(ilike(documents.name, `%${escapeLike(query.q)}%`))
    const where = filters.length > 0 ? and(...filters) : undefined

    const [countRow] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(where)
    const total = countRow?.count ?? 0

    const rows = await deps.db
      .select({ document: documents, ownerName: users.name })
      .from(documents)
      .innerJoin(users, eq(documents.ownerId, users.id))
      .where(where)
      .orderBy(query.sort === 'updated_at_asc' ? asc(documents.updatedAt) : desc(documents.updatedAt))
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size)

    // Corpus-wide per-status counts for the web KPI strip (independent of filters).
    const counts: Record<DocumentRow['status'], number> = { draft: 0, ready: 0, publishing: 0, published: 0, failed: 0 }
    const countRows = await deps.db
      .select({ status: documents.status, count: sql<number>`count(*)::int` })
      .from(documents)
      .groupBy(documents.status)
    for (const row of countRows) counts[row.status] = row.count

    return c.json({
      items: rows.map((r) => documentShape(r.document, r.ownerName)),
      total,
      page: query.page,
      page_size: query.page_size,
      counts,
    })
  })

  // POST /documents — multipart upload streamed to RagFlow, stored unparsed.
  app.post('/', async (c) => {
    const user = c.get('user')
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return sendError(c, 400, 'validation_error', 'Invalid upload', { file: ['Expected a multipart/form-data upload'] })
    }
    const contentLength = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      return sendError(c, 413, 'payload_too_large', 'Uploaded file must be at most 1 GiB')
    }
    return await receiveUpload(c, user, contentType, deps, ragflow)
  })

  // GET /documents/:id — detail with history.
  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return sendError(c, 404, 'not_found', 'Document not found')
    const row = await findDocumentWithOwner(deps.db, id)
    if (row === undefined) return sendError(c, 404, 'not_found', 'Document not found')
    const history = await deps.db
      .select({
        id: documentHistory.id,
        actorId: documentHistory.actorId,
        actorName: users.name,
        fromStatus: documentHistory.fromStatus,
        toStatus: documentHistory.toStatus,
        note: documentHistory.note,
        createdAt: documentHistory.createdAt,
      })
      .from(documentHistory)
      .innerJoin(users, eq(documentHistory.actorId, users.id))
      .where(eq(documentHistory.documentId, id))
      .orderBy(asc(documentHistory.createdAt))
    return c.json({
      document: documentShape(row.document, row.ownerName),
      history: history.map((h) => ({
        id: h.id,
        actor: { id: h.actorId, name: h.actorName },
        from_status: h.fromStatus,
        to_status: h.toStatus,
        note: h.note,
        created_at: h.createdAt.toISOString(),
      })),
    })
  })

  // GET /documents/:id/download — proxy-streams RagFlow's file in any status.
  app.get('/:id/download', async (c) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return sendError(c, 404, 'not_found', 'Document not found')
    const row = await findDocumentWithOwner(deps.db, id)
    if (row === undefined) return sendError(c, 404, 'not_found', 'Document not found')
    let upstream: Response
    try {
      upstream = await ragflow.downloadDocument(row.document.ragflowDocumentId)
    } catch (err) {
      if (err instanceof RagflowError) return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
      throw err
    }
    if (!upstream.ok) return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
    return new Response(upstream.body, {
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${sanitizeFilename(row.document.name)}"`,
        ...(upstream.headers.get('content-length') !== null
          ? { 'content-length': upstream.headers.get('content-length') ?? '' }
          : {}),
      },
    })
  })

  return app
}

interface UploadValidation {
  code: 'validation_error'
  message: string
  fields: Record<string, string[]>
}

/**
 * Parses the multipart body with busboy (streaming), validates the file part
 * from its headers, and pipes the file straight into RagFlow without ever
 * buffering it. The RagFlow document is created unparsed (run: UNSTART).
 */
async function receiveUpload(
  c: Context<{ Variables: { user: User } }>,
  user: User,
  contentType: string,
  deps: Deps,
  ragflow: RagflowClient,
): Promise<Response> {
  const rawBody = c.req.raw.body
  if (rawBody === null) {
    return sendError(c, 400, 'validation_error', 'Invalid upload', { file: ['A file is required'] })
  }

  const bb = Busboy({
    headers: { 'content-type': contentType },
    limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
  })

  // Mutable state for the event callbacks; a single object keeps narrowing
  // sound across the closure boundary.
  const state: {
    picked: RagflowUploadInput | null
    validation: UploadValidation | null
    tooLarge: boolean
    tooManyFiles: boolean
    parseFailed: boolean
    upload: Promise<RagflowUploadResult> | null
    sizeBytes: number
  } = {
    picked: null,
    validation: null,
    tooLarge: false,
    tooManyFiles: false,
    parseFailed: false,
    upload: null,
    sizeBytes: 0,
  }

  const finished = new Promise<void>((resolve) => {
    // Natural completion emits 'finish'; destroy() (validation failures) emits 'close'.
    bb.on('finish', () => resolve())
    bb.on('close', () => resolve())
    bb.on('error', () => {
      state.parseFailed = true
      resolve()
    })
  })

  bb.on('file', (_fieldname, stream, filename, _transferEncoding, mimeType) => {
    if (state.picked !== null) {
      stream.resume()
      return
    }
    const ext = fileExtension(filename)
    if (!isSupportedSuffix(ext)) {
      state.validation = {
        code: 'validation_error',
        message: 'Invalid file type',
        fields: { file: [ext === '' ? 'A file is required' : `Unsupported file type .${ext}`] },
      }
      bb.destroy()
      return
    }
    if (utf8ByteLength(filename) > MAX_NAME_BYTES) {
      state.validation = {
        code: 'validation_error',
        message: 'Invalid file name',
        fields: { name: ['File name must be at most 255 UTF-8 bytes'] },
      }
      bb.destroy()
      return
    }
    state.picked = { stream, filename, mimeType: mimeType || 'application/octet-stream' }
    stream.on('data', (chunk: Buffer) => {
      state.sizeBytes += chunk.length
    })
    // Stream to RagFlow immediately — the body must be consumed as it arrives.
    const pending = ragflow.uploadDocument(state.picked)
    state.upload = pending
    // Sink for rejections on early-return paths; the happy path awaits the promise.
    pending.catch(() => {})
  })
  bb.on('limit', () => {
    state.tooLarge = true
  })
  bb.on('filesLimit', () => {
    state.tooManyFiles = true
  })

  Readable.fromWeb(rawBody).pipe(bb)
  await finished

  if (state.tooLarge) {
    // Backstop for clients that lie about content-length: the RagFlow
    // document may have been created before the limit tripped — clean it up.
    const partial = await state.upload?.catch(() => null)
    if (partial !== undefined && partial !== null && state.picked !== null) {
      void ragflow.deleteDocument(partial.documentId).catch(() => {})
    }
    return sendError(c, 413, 'payload_too_large', 'Uploaded file must be at most 1 GiB')
  }
  if (state.tooManyFiles) return sendError(c, 400, 'validation_error', 'Invalid upload', { file: ['Only one file per upload'] })
  if (state.validation !== null) {
    return sendError(c, 400, state.validation.code, state.validation.message, state.validation.fields)
  }
  // A parse failure with no upload started means a malformed multipart body.
  if (state.parseFailed && state.upload === null) {
    return sendError(c, 400, 'validation_error', 'Invalid upload', { file: ['Could not parse the multipart body'] })
  }
  if (state.picked === null || state.upload === null) {
    return sendError(c, 400, 'validation_error', 'Invalid upload', { file: ['A file is required'] })
  }

  const picked = state.picked
  const ext = fileExtension(picked.filename)
  let result: RagflowUploadResult
  try {
    result = await state.upload
  } catch {
    return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
  }

  const [document] = await deps.db
    .insert(documents)
    .values({
      name: picked.filename,
      ext,
      sizeBytes: state.sizeBytes,
      ragflowDocumentId: result.documentId,
      chunkMethod: deriveChunkMethod(ext),
      status: 'draft',
      ownerId: user.id,
      chunkCount: result.chunkCount,
    })
    .returning()
  if (document === undefined) throw new Error('INSERT ... RETURNING returned no row')

  await deps.db.insert(documentHistory).values({
    documentId: document.id,
    actorId: user.id,
    fromStatus: null,
    toStatus: 'draft',
    note: 'Uploaded',
  })

  return c.json({ document: documentShape(document, user.name) }, 201)
}
