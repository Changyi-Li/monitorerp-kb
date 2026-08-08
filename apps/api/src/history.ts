import type { DB } from './db/client.js'
import { documentHistory, documents } from './db/schema.js'

type DocumentStatus = (typeof documents.$inferSelect)['status']

export interface TransitionInput {
  documentId: string
  actorId: string | null // null = system (sweeper) transition
  fromStatus: DocumentStatus | null
  toStatus: DocumentStatus
  note: string
}

/** Records a document status transition (every transition writes a history row). */
export async function recordDocumentTransition(db: DB, input: TransitionInput): Promise<void> {
  await db.insert(documentHistory).values({
    documentId: input.documentId,
    actorId: input.actorId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    note: input.note,
  })
}
