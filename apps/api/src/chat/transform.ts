// The core streaming logic: a pure, framework-agnostic transform that
// consumes RagFlow agent SSE frames and emits the normalized event contract
// (chatbot spec #23).
//
// Reasoning in the LIVE STREAM is gated by boolean flags on `message` frames —
// a leading {"content":"","start_to_think":true}, then reasoning tokens, then
// {"content":"","end_to_think":true} — NOT by <think> tags (issue #32). The
// transform tracks a `reasoning` state across frames and routes content to
// `thinking` or `answer` accordingly. Component-level reasoning also arrives
// in a `node_started`/`node_finished` frame's `data.thoughts`, which is
// surfaced as `thinking` too.
//
// NOTE: the STORED-history path is different — RagFlow persists reasoning
// inline as literal <think>…</think> tags inside the assistant message
// content. `splitThinking` (below) handles that whole-string form and is used
// only by the history shape, not by this streaming transform.
//
// The transform is deliberately DB- and HTTP-free: the route wires it to real
// RagFlow SSE and injects the citation→Document lookup, and the unit test
// drives it with scripted frames.

export interface ChatCitation {
  /** Matches the [n] marker in the answer (rewritten from the agent's [ID:n]
   * markers by the transform — issue #30). */
  n: number
  /** The cited chunk passage — leads the source card. */
  content: string
  document_name: string
  /** First page from positions, if any. */
  page: number | null
  ragflow_document_id: string
  /** Our documents.id when the source is one of our Documents, else null. */
  document_id: string | null
}

export type ChatTransformEvent =
  | { type: 'session'; id: string }
  | { type: 'thinking'; delta: string }
  | { type: 'answer'; delta: string }
  | { type: 'references'; items: ChatCitation[] }
  | { type: 'done' }
  | { type: 'error'; code: 'upstream_error'; message: string }

export interface CompletionTransform {
  /** Feeds one complete SSE frame and returns the events it produced. */
  feed(frame: string): ChatTransformEvent[]
}

/** Maps a RagFlow document id to one of our Documents — the route injects a
 * real lookup against `documents.ragflow_document_id`. */
export type DocumentIdLookup = (ragflowDocumentId: string) => string | null

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/** The real agent's citation-marker prefix (issue #30): it cites with
 * `[ID:<citation id>]` where the id is an arbitrary integer — the chunks-map
 * key / stored citation_id — never the [n] ordinals the contract promises. */
const MARKER_PREFIX = '[ID:'

interface ParsedFrame {
  event: string | null
  data: string | null
}

function parseFrame(frame: string): ParsedFrame {
  let event: string | null = null
  let data: string | null = null
  for (const line of frame.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim()
    else if (trimmed.startsWith('data:')) data = trimmed.slice(5).trim()
  }
  return { event, data }
}

interface FramePayload {
  code?: unknown
  message?: unknown
  // session_id is a TOP-LEVEL field of every real agent frame (bug #29), not
  // nested under data as the old scripted shape had it.
  session_id?: unknown
  data?: {
    content?: unknown
    reference?: unknown
    // Live-stream reasoning delimiters on `message` frames (issue #32). The
    // flag frames themselves carry no content; they toggle the reasoning state.
    start_to_think?: unknown
    end_to_think?: unknown
    // Component-level reasoning on `node_started`/`node_finished` frames.
    thoughts?: unknown
  }
}

/** First page from the positions arrays, if any ([page, x, y, w, h] each). */
function firstPage(positions: unknown): number | null {
  if (!Array.isArray(positions)) return null
  const first = positions[0]
  if (!Array.isArray(first)) return null
  const page = first[0]
  return typeof page === 'number' && Number.isFinite(page) ? page : null
}

/**
 * Normalizes one raw citation (from either shape) into the contract shape.
 * Items without a RagFlow document id are dropped — they could never map.
 */
function normalizeCitation(
  raw: unknown,
  n: number,
  documentIdLookup: DocumentIdLookup,
): ChatCitation | null {
  // A non-numeric ordinal could never match a [n] marker in the answer.
  if (!Number.isInteger(n) || n < 1) return null
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as { content?: unknown; document_id?: unknown; document_name?: unknown; positions?: unknown }
  if (typeof item.document_id !== 'string' || item.document_id === '') return null
  return {
    n,
    content: typeof item.content === 'string' ? item.content : '',
    document_name: typeof item.document_name === 'string' ? item.document_name : '',
    page: firstPage(item.positions),
    ragflow_document_id: item.document_id,
    document_id: documentIdLookup(item.document_id),
  }
}

/**
 * The [ID:n] marker key for a STORED-HISTORY citation: its numeric
 * `citation_id` (issue #30). The stored list is in retrieval order, which is
 * NOT the citation numbering the agent's markers use — list order would map
 * [ID:41] to the wrong chunk. Accepts the real wire's string form (verified
 * live 2026-08-10) and a JSON-number form defensively. Items whose
 * citation_id is missing or non-numeric resolve to NaN and are dropped by
 * normalizeCitation (no marker could ever match them).
 */
function storedCitationNumber(item: unknown): number {
  const citationId = (item as { citation_id?: unknown } | null)?.citation_id
  return typeof citationId === 'string' || typeof citationId === 'number' ? Number(citationId) : Number.NaN
}

/**
 * Normalizes the TWO raw citation shapes (research #20) into the one contract
 * shape: the live object `{chunks: {<citation id>: …}}` from message_end
 * (n = the map key — already the marker number), and the stored-history LIST
 * of items (n = the item's numeric citation_id).
 */
export function normalizeReference(reference: unknown, documentIdLookup: DocumentIdLookup): ChatCitation[] {
  if (reference === null || typeof reference !== 'object') return []
  if (Array.isArray(reference)) {
    return reference
      .map((item) => normalizeCitation(item, storedCitationNumber(item), documentIdLookup))
      .filter((c): c is ChatCitation => c !== null)
  }
  const chunks = (reference as { chunks?: unknown }).chunks
  if (chunks === null || typeof chunks !== 'object' || Array.isArray(chunks)) return []
  // The live map keys ARE the citation ids the [ID:n] markers use.
  return Object.entries(chunks as Record<string, unknown>)
    .map(([citationId, item]) => normalizeCitation(item, Number(citationId), documentIdLookup))
    .filter((c): c is ChatCitation => c !== null)
}

/**
 * Rewrites the real agent's `[ID:<citation id>]` markers to the contract's
 * [n] form in a COMPLETE content string (the stored-history path, where the
 * whole message is at hand). The streaming path's scanAnswer performs the
 * same rewrite statefully across deltas (issue #30).
 */
export function normalizeAnswerMarkers(content: string): string {
  // ASCII digits only — the streaming scanAnswer accepts the same range, so
  // the whole-string and delta paths can never disagree on a marker.
  return content.replace(/\[ID:([0-9]+)\]/g, '[$1]')
}

/**
 * Splits a COMPLETE stored-history content string into reasoning and answer.
 * This is the ONLY place `<think>` tags are parsed: the live stream delimits
 * reasoning with start_to_think/end_to_think flags (issue #32), but RagFlow
 * PERSISTS the reasoning inline as <think>…</think> tags, so stored history
 * needs this whole-string scan. Multiple think blocks concatenate; an
 * unclosed block counts as reasoning.
 */
export function splitThinking(content: string): { thinking: string; answer: string } {
  let thinking = ''
  let answer = ''
  let rest = content
  let inThink = false
  while (rest.length > 0) {
    if (inThink) {
      const close = rest.indexOf(CLOSE_TAG)
      if (close === -1) {
        thinking += rest
        break
      }
      thinking += rest.slice(0, close)
      rest = rest.slice(close + CLOSE_TAG.length)
      inThink = false
    } else {
      const open = rest.indexOf(OPEN_TAG)
      if (open === -1) {
        answer += rest
        break
      }
      answer += rest.slice(0, open)
      rest = rest.slice(open + OPEN_TAG.length)
      inThink = true
    }
  }
  return { thinking, answer }
}

export function createCompletionTransform(options: {
  lazy: boolean
  documentIdLookup?: DocumentIdLookup
}): CompletionTransform {
  const documentIdLookup: DocumentIdLookup = options.documentIdLookup ?? (() => null)
  let finished = false
  let sessionEmitted = false
  let referencesEmitted = false
  // True between a `start_to_think:true` message frame and the matching
  // `end_to_think:true` — content in that window is reasoning (issue #32).
  let reasoning = false
  // Citation-marker lookahead: answer text held back because an [ID:n] marker
  // may be cut mid-delta. Bounded by the marker prefix and its digit run.
  let buffer = ''

  /**
   * Emits one answer delta for a content frame, rewriting the agent's [ID:n]
   * citation markers to the contract's [n] form (issue #30). A marker that a
   * delta cuts in half — '[ID:', or a marker's digit run at the frame
   * boundary — resolves once the next delta lands; the buffer holds only the
   * ambiguous suffix. Reasoning content never reaches here (it is emitted raw
   * as `thinking` by `feed`, gated on the `reasoning` flag — issue #32).
   */
  const scanAnswer = (content: string): ChatTransformEvent[] => {
    buffer += content
    let pending = ''
    while (buffer.length > 0) {
      const pos = buffer.indexOf('[')
      if (pos === -1) {
        pending += buffer
        buffer = ''
        break
      }
      const suffix = buffer.slice(pos)
      if (suffix.length < MARKER_PREFIX.length && MARKER_PREFIX.startsWith(suffix)) {
        // Split marker prefix ('[', '[I', '[ID') — hold for the next frame.
        pending += buffer.slice(0, pos)
        buffer = buffer.slice(pos)
        break
      }
      if (suffix.startsWith(MARKER_PREFIX)) {
        // '[ID:<digits>]' — a complete marker is appended rewritten as [n];
        // digits at the frame boundary are held until ']' (or a non-digit)
        // lands, because a digit run may still be a marker.
        let j = pos + MARKER_PREFIX.length
        while (j < buffer.length && buffer.charAt(j) >= '0' && buffer.charAt(j) <= '9') j++
        const digits = buffer.slice(pos + MARKER_PREFIX.length, j)
        if (j < buffer.length && buffer.charAt(j) === ']' && digits.length > 0) {
          pending += buffer.slice(0, pos)
          pending += `[${digits}]`
          buffer = buffer.slice(j + 1)
          continue
        }
        if (j === buffer.length) {
          // Mid-marker at the end of the frame — hold everything from '['.
          pending += buffer.slice(0, pos)
          buffer = buffer.slice(pos)
          break
        }
        // '[ID:…' that never completes as a marker — plain text.
        pending += buffer.slice(0, j)
        buffer = buffer.slice(j)
      } else {
        // A literal '[' that is not a marker start.
        pending += buffer.slice(0, pos + 1)
        buffer = buffer.slice(pos + 1)
      }
    }
    return pending !== '' ? [{ type: 'answer', delta: pending }] : []
  }

  const terminalError = (message: string): ChatTransformEvent[] => {
    finished = true
    return [{ type: 'error', code: 'upstream_error', message }]
  }

  const feed = (frame: string): ChatTransformEvent[] => {
    if (finished) return []
    const { data } = parseFrame(frame)
    if (data === null || data === '') return terminalError('RagFlow returned an unparseable stream frame')

    if (data === '[DONE]') {
      // The held buffer, if any, is an incomplete [ID:n] marker fragment cut
      // off by the stream ending — not answer text, so it is dropped.
      // Reasoning is emitted immediately as it arrives (no buffering), so
      // nothing is held on the thinking side either.
      finished = true
      buffer = ''
      return [{ type: 'done' }]
    }

    let payload: FramePayload
    try {
      payload = JSON.parse(data) as FramePayload
    } catch {
      return terminalError('RagFlow returned an unparseable stream frame')
    }
    // Real agent frames carry no `code` field at all (bug #29: `undefined !==
    // 0` treated every success frame as an error and killed the stream on the
    // first one) — only a present, non-zero code is a rejection.
    if (typeof payload.code === 'number' && payload.code !== 0) {
      const message = typeof payload.message === 'string' ? payload.message : 'RagFlow reported an error'
      return terminalError(message)
    }

    const out: ChatTransformEvent[] = []
    const sessionId = payload.session_id
    // Lazy create: the first frame carrying the auto-created session id emits
    // the leading session event; the route maps it to our row's id.
    if (options.lazy && !sessionEmitted && typeof sessionId === 'string' && sessionId !== '') {
      sessionEmitted = true
      out.push({ type: 'session', id: sessionId })
    }
    // Live-stream reasoning delimiters (issue #32): the flag frames carry no
    // content; they toggle the reasoning state for the content frames that
    // follow. Content is emitted raw while reasoning (citations never appear
    // in reasoning) and through scanAnswer's marker rewriting otherwise.
    if (payload.data?.start_to_think === true) reasoning = true
    if (payload.data?.end_to_think === true) reasoning = false
    if (typeof payload.data?.content === 'string' && payload.data.content !== '') {
      if (reasoning) out.push({ type: 'thinking', delta: payload.data.content })
      else out.push(...scanAnswer(payload.data.content))
    }
    // Component-level reasoning on node frames — a separate, earlier channel
    // than the message stream (issue #32).
    if (typeof payload.data?.thoughts === 'string' && payload.data.thoughts !== '') {
      out.push({ type: 'thinking', delta: payload.data.thoughts })
    }
    // The message_end frame carries the citations (live chunks-object shape);
    // the terminal references event is emitted once, before done.
    if (!referencesEmitted) {
      const items = normalizeReference(payload.data?.reference, documentIdLookup)
      if (items.length > 0) {
        referencesEmitted = true
        out.push({ type: 'references', items })
      }
    }
    return out
  }

  // Note: a stream that ends without [DONE] simply stops — the held buffer
  // (an incomplete marker fragment) is never answer text, so there is nothing
  // to flush on end-of-stream.

  return { feed }
}
