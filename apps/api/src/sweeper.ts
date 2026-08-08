import { eq } from 'drizzle-orm'
import type { DB } from './db/client.js'
import { documents } from './db/schema.js'
import { recordDocumentTransition } from './history.js'
import type { RagflowClient, RagflowDocumentState } from './ragflow/client.js'

/** RagFlow reports progress 0..1; the app stores whole percent. */
function toPercent(progress: number): number {
  return progress <= 1 ? Math.round(progress * 100) : Math.round(progress)
}

async function settleFailed(db: DB, documentId: string, lastError: string, note: string): Promise<void> {
  await db
    .update(documents)
    .set({ status: 'failed', lastError, progress: 0, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
  await recordDocumentTransition(db, {
    documentId,
    actorId: null,
    fromStatus: 'publishing',
    toStatus: 'failed',
    note,
  })
}

/**
 * One sweeper pass: reconciles every publishing document against RagFlow's
 * run state. Exported so tests can invoke it deterministically instead of
 * waiting POLL_INTERVAL_MS (the spec's only testability concession).
 */
export async function sweeperTick(db: DB, ragflow: RagflowClient): Promise<void> {
  const publishing = await db.select().from(documents).where(eq(documents.status, 'publishing'))
  if (publishing.length === 0) return

  let states: Map<string, RagflowDocumentState>
  try {
    states = new Map((await ragflow.listDocuments()).map((s) => [s.id, s]))
  } catch {
    // RagFlow unreachable — skip the tick; never a false failure.
    return
  }

  for (const doc of publishing) {
    const state = states.get(doc.ragflowDocumentId)
    if (state === undefined) {
      await settleFailed(db, doc.id, 'Removed in RagFlow', 'Removed in RagFlow')
      continue
    }
    switch (state.run) {
      case 'DONE':
        await db
          .update(documents)
          .set({
            status: 'published',
            chunkCount: state.chunkCount,
            retryCount: 0,
            publishedAt: new Date(),
            progress: 100,
            lastError: null, // a successful parse wipes the failure record
            updatedAt: new Date(),
          })
          .where(eq(documents.id, doc.id))
        await recordDocumentTransition(db, {
          documentId: doc.id,
          actorId: null,
          fromStatus: 'publishing',
          toStatus: 'published',
          note: 'Parse completed',
        })
        break
      case 'FAIL':
        await settleFailed(db, doc.id, state.progressMsg ?? 'Parse failed', 'Parse failed')
        break
      case 'CANCEL':
        await settleFailed(db, doc.id, state.progressMsg ?? 'cancelled', 'Parse cancelled')
        break
      default: // RUNNING / UNSTART — still in flight; refresh progress.
        await db
          .update(documents)
          .set({ progress: toPercent(state.progress), updatedAt: new Date() })
          .where(eq(documents.id, doc.id))
        break
    }
  }
}

/** Polls RagFlow on an interval (single-replica assumption). */
export function startSweeper(
  deps: { db: DB; ragflow: RagflowClient },
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweeperTick(deps.db, deps.ragflow)
  }, intervalMs)
  timer.unref()
  return timer
}
