// The core streaming logic: a pure, framework-agnostic transform that
// consumes RagFlow agent SSE frames and emits the normalized event contract
// (chatbot spec #23). Reasoning arrives inline as literal <think>…</think>
// tags that may span multiple deltas (research #20); the transform splits
// each delta into thinking and answer events statefully, so the client never
// parses tags.
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

/** The longest fragment of the close tag that could still be a split-tag suffix. */
const CLOSE_HOLD = CLOSE_TAG.length - 1

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
  data?: { content?: unknown; reference?: unknown }
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
 * Splits a COMPLETE stored content string into reasoning and answer — the
 * streaming transform's scanAnswer handles deltas with split-tag holds; a
 * stored message is whole, so a straightforward scan suffices. Multiple
 * think blocks concatenate; an unclosed block counts as reasoning.
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
  let inThink = false
  // Split-tag/marker lookahead: text that must not be emitted yet because a
  // tag or citation marker may be cut mid-delta. Bounded by the tag lengths,
  // or by a split [ID:n] marker's digit run.
  let buffer = ''

  /**
   * Splits a content delta into answer parts, tracking the <think> state
   * across deltas, and rewrites the agent's [ID:n] citation markers to the
   * contract's [n] form (issue #30). A tag or marker that a delta cuts in
   * half — '<thi' open, '</th' close, '[ID:', or a marker's digit run at the
   * frame boundary — resolves once the next delta lands; the buffer holds
   * only the ambiguous suffix.
   */
  const scanAnswer = (content: string): ChatTransformEvent[] => {
    const out: ChatTransformEvent[] = []
    buffer += content
    // A held fragment is suspended until the next frame arrives — once a
    // branch holds, the scan is done for this frame (the held text would
    // otherwise rescan identically forever).
    let done = false
    while (!done && buffer.length > 0) {
      if (inThink) {
        const close = buffer.indexOf(CLOSE_TAG)
        if (close === -1) {
          // All thinking — emit everything but a possible split close-tag.
          if (buffer.length > CLOSE_HOLD) {
            out.push({ type: 'thinking', delta: buffer.slice(0, -CLOSE_HOLD) })
          }
          buffer = buffer.slice(-CLOSE_HOLD)
          done = true
        } else {
          if (close > 0) out.push({ type: 'thinking', delta: buffer.slice(0, close) })
          inThink = false
          buffer = buffer.slice(close + CLOSE_TAG.length)
        }
      } else {
        // Scan for the next '<' (think-tag open) or '[' (citation marker).
        // Text and rewritten markers accumulate into one answer delta per
        // frame; a tag or marker fragment cut mid-delta is held for the next.
        let pending = ''
        while (buffer.length > 0) {
          const lt = buffer.indexOf('<')
          const lb = buffer.indexOf('[')
          const pos = lt === -1 ? lb : lb === -1 ? lt : Math.min(lt, lb)
          if (pos === -1) {
            pending += buffer
            buffer = ''
            break
          }
          if (buffer.charAt(pos) === '<') {
            const suffix = buffer.slice(pos)
            if (suffix.length < OPEN_TAG.length && OPEN_TAG.startsWith(suffix)) {
              // Split open-tag prefix — hold for the next frame.
              pending += buffer.slice(0, pos)
              buffer = buffer.slice(pos)
              break
            }
            if (suffix.startsWith(OPEN_TAG)) {
              pending += buffer.slice(0, pos)
              buffer = buffer.slice(pos + OPEN_TAG.length)
              inThink = true
              break
            }
            // A literal '<' that is not a tag start.
            pending += buffer.slice(0, pos + 1)
            buffer = buffer.slice(pos + 1)
          } else {
            const suffix = buffer.slice(pos)
            if (suffix.length < MARKER_PREFIX.length && MARKER_PREFIX.startsWith(suffix)) {
              // Split marker prefix ('[', '[I', '[ID') — hold for the next frame.
              pending += buffer.slice(0, pos)
              buffer = buffer.slice(pos)
              break
            }
            if (suffix.startsWith(MARKER_PREFIX)) {
              // '[ID:<digits>]' — a complete marker is appended rewritten as
              // [n]; digits at the frame boundary are held until ']' (or a
              // non-digit) lands, because a digit run may still be a marker.
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
        }
        if (pending !== '') out.push({ type: 'answer', delta: pending })
        // A tag open hands the scan to the think branch; everything else
        // (buffer exhausted or a held fragment) ends this frame's scan.
        if (!inThink) done = true
      }
    }
    return out
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
      // The held buffer is an unclosed tag or marker fragment (dropped — it
      // is not answer text) or, when the stream ends mid-thinking, a fragment
      // of reasoning that was already streamed as earlier thinking deltas —
      // emit it so the reconstructed reasoning is not truncated.
      finished = true
      const thinkingTail = inThink && buffer.length > 0 ? [{ type: 'thinking' as const, delta: buffer }] : []
      buffer = ''
      return [...thinkingTail, { type: 'done' }]
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
    if (typeof payload.data?.content === 'string') {
      out.push(...scanAnswer(payload.data.content))
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

  // Note: a stream that ends without [DONE] simply stops — the held fragment
  // (an unclosed tag or thinking) is never answer text, so there is nothing
  // to flush on end-of-stream.

  return { feed }
}
