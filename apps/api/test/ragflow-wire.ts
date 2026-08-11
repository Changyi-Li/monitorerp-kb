/**
 * RAGFLOW WIRE EXPECTATIONS — the shared, documented module the RagFlow stub
 * scripts and the live revalidation gate audits against (stage (c) of the
 * release gate, spec #28 / ticket #35). The stub's scripted responses are
 * built from the same builders this audit asserts with, so the fake and its
 * audit cannot drift apart.
 *
 * ─────────────────────────── EXPECTATIONS TABLE ───────────────────────────
 *
 * All shapes below were verified live against RagFlow v0.26.4 (issues
 * #13/#14, bug #29 family, research #20; captured 2026-08-10). The
 * revalidation suite probes every row except the chunk-method PUT and the
 * document download — those are the contract stage's (a+) territory.
 *
 * | API | Request | Verified response | Verified in |
 * |---|---|---|---|
 * | List documents | `GET /api/v1/datasets/{dataset_id}/documents` | HTTP 200; `data` is an OBJECT `{docs: [...], total: n}` — never a bare array | issue #14 |
 * | Upload | `POST /api/v1/datasets/{dataset_id}/documents` (multipart `file` field) | HTTP 200; `data` is an ARRAY of documents, even for a single file | issue #13 |
 * | Parse trigger | `POST /api/v1/datasets/{dataset_id}/chunks`, JSON body `{document_ids: [...]}` | HTTP 200; rejections arrive as HTTP 200 + non-zero `code`, never 4xx/5xx | issue #14 |
 * | Delete documents | `DELETE /api/v1/datasets/{dataset_id}/documents`, JSON body `{ids: [...]}` | HTTP 200, `{code: 0}`; DELETE on the single-document path answers 405 | issue #14 |
 * | Chunk-method flip | `PUT /api/v1/datasets/{dataset_id}/documents/{doc_id}`, JSON body `{chunk_method}` | HTTP 200, `{code: 0}` (contract stage probes this, not stage (c)) | issue #14 |
 * | Session get | `GET /api/v1/agents/{agent_id}/sessions?id=...&dsl=false` | HTTP 200; `data` wraps the session in a one-element ARRAY with `message[]` history | bug #29 family |
 * | Session delete | `DELETE /api/v1/agents/{agent_id}/sessions`, JSON body `{ids: [...], delete_all: false}` | HTTP 200, `{code: 0}` | research #20 |
 * | Agent completion | `POST /api/v1/agents/chat/completions`, JSON body `{agent_id, query, stream: true, session_id?}` | HTTP 200 `text/event-stream`; every frame is a single `data:` line of `{event, message_id, task_id, data, session_id}` — success frames carry NO `code`, session_id sits at the TOP LEVEL; stream ends `data: [DONE]` | bug #29, issues #30/#32 |
 *
 * Version history: v0.26.4 — table initially verified live (2026-08-10).
 */

/** The RagFlow version the expectations table was last verified against.
 * Bump this and add a version-history note above after a successful
 * `npm run gate:revalidation` run against a newer version. */
export const RAGFLOW_VERSION_VALIDATED = 'v0.26.4'

// ── Dataset API: /api/v1/datasets/{id}/... ────────────────────────────────

const stripTrailingSlash = (base: string): string => base.replace(/\/+$/, '')

/** The documents collection endpoint — upload (POST), list (GET), delete
 * (DELETE with `ids` in the body). */
export const datasetDocumentsUrl = (base: string, datasetId: string): string =>
  `${stripTrailingSlash(base)}/api/v1/datasets/${datasetId}/documents`

/** The parse-trigger endpoint — POST with `document_ids` in the JSON body. */
export const datasetChunksUrl = (base: string, datasetId: string): string =>
  `${stripTrailingSlash(base)}/api/v1/datasets/${datasetId}/chunks`

/** Parse trigger body: `document_ids` (plural, array) in the JSON body, NOT
 * a `document_id` query param (issue #14). */
export const parseTriggerBody = (documentIds: string[]): { document_ids: string[] } => ({ document_ids: documentIds })

/** Delete body: `ids` in the collection-endpoint body, NOT the single-document
 * path (issue #14). */
export const deleteDocumentsBody = (ids: string[]): { ids: string[] } => ({ ids })

// ── Agent API: /api/v1/agents/... ─────────────────────────────────────────

export const agentSessionsUrl = (base: string, agentId: string): string =>
  `${stripTrailingSlash(base)}/api/v1/agents/${agentId}/sessions`

export const agentCompletionsUrl = (base: string): string =>
  `${stripTrailingSlash(base)}/api/v1/agents/chat/completions`

/** Session fetch params: `?id=...&dsl=false` — dsl=false keeps the ~2 MB
 * canvas payload out of the response (research #20). */
export const sessionFetchParams = (sessionId: string): { id: string; dsl: string } => ({ id: sessionId, dsl: 'false' })

/** Session delete body: `ids` + `delete_all` (research #20). */
export const sessionDeleteBody = (sessionId: string): { ids: string[]; delete_all: boolean } => ({
  ids: [sessionId],
  delete_all: false,
})

/** Completion request body: `stream: true`; `session_id` is OMITTED entirely
 * for lazy session auto-create — sending null would create a session named
 * "None" upstream (research #20). */
export const completionRequestBody = (
  agentId: string,
  query: string,
  sessionId?: string,
): { agent_id: string; query: string; stream: true; session_id?: string } => {
  const body: { agent_id: string; query: string; stream: true; session_id?: string } = { agent_id: agentId, query, stream: true }
  if (sessionId !== undefined) body['session_id'] = sessionId
  return body
}

// ── Response envelopes ────────────────────────────────────────────────────

/** The dataset API's `{code, data}` envelope; a bare `{code: 0}` when no data
 * is carried (deletes, the chunk-method PUT). */
export const okPayload = <T>(data?: T): { code: 0; data?: T } => (data === undefined ? { code: 0 } : { code: 0, data })

/** Rejection envelope: HTTP 200 with a non-zero `code` (issue #14) — never a
 * 4xx/5xx. */
export const rejectionPayload = (code: number, message: string): { code: number; message: string } => ({ code, message })

/** List response: `data` is an OBJECT with `docs`/`total` (issue #14). */
export const listPayload = <T>(docs: T[], total: number): { code: 0; data: { docs: T[]; total: number } } =>
  okPayload({ docs, total }) as { code: 0; data: { docs: T[]; total: number } }

/** Upload response: `data` is an ARRAY of documents, even for a single-file
 * upload (issue #13). */
export const uploadPayload = <T>(docs: T[]): { code: 0; data: T[] } => okPayload(docs) as { code: 0; data: T[] }

// ── Agent completion SSE ──────────────────────────────────────────────────

/** The stream terminator every real RagFlow agent stream ends with — the
 * token and its framed form, single-sourced so the stub's script and the
 * audit's assertion cannot drift apart. */
export const COMPLETION_DONE = '[DONE]'
export const COMPLETION_DONE_FRAME = `data: ${COMPLETION_DONE}`

/**
 * One real RagFlow agent completion SSE frame (wire shape verified live on
 * 2026-08-10, bug #29): a single `data:` line whose JSON is {event,
 * message_id, task_id, data, session_id}. Success frames carry NO `code`
 * field — the dataset API's `{code, data}` envelope is not the agent
 * stream's — and session_id sits at the TOP LEVEL.
 *
 * Single-sourced here so the unit tests and the RagFlow stub build identical
 * frames: drift between the scripted shape and the real wire was the root
 * cause of bug #29.
 */
export const realCompletionFrame = (event: string, data: Record<string, unknown>, sessionId: string): string =>
  `data:${JSON.stringify({ event, message_id: 'msg-1', task_id: 'task-1', data, session_id: sessionId })}`
