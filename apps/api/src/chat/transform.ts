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
  /** Matches the [n] marker in the answer. */
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

/** The longest fragment of a tag that could still be a split-tag prefix. */
const OPEN_HOLD = OPEN_TAG.length - 1
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
  data?: { content?: unknown; session_id?: unknown; reference?: unknown }
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
 * Normalizes the TWO raw citation shapes (research #20) into the one contract
 * shape: the live object `{chunks: {<ordinal>: …}}` from message_end, and the
 * stored-history LIST of items (ordinals from list order).
 */
export function normalizeReference(reference: unknown, documentIdLookup: DocumentIdLookup): ChatCitation[] {
  if (reference === null || typeof reference !== 'object') return []
  if (Array.isArray(reference)) {
    return reference
      .map((item, index) => normalizeCitation(item, index + 1, documentIdLookup))
      .filter((c): c is ChatCitation => c !== null)
  }
  const chunks = (reference as { chunks?: unknown }).chunks
  if (chunks === null || typeof chunks !== 'object' || Array.isArray(chunks)) return []
  return Object.entries(chunks as Record<string, unknown>)
    .map(([ordinal, item]) => normalizeCitation(item, Number(ordinal), documentIdLookup))
    .filter((c): c is ChatCitation => c !== null)
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
  // Split-tag lookahead: text that must not be emitted yet because a tag may
  // be cut mid-delta. Bounded by the tag lengths.
  let buffer = ''

  /**
   * Splits a content delta into answer parts, tracking the <think> state
   * across deltas. A tag that a delta cuts in half resolves once the next
   * delta lands; the buffer holds only the ambiguous suffix.
   */
  const scanAnswer = (content: string): ChatTransformEvent[] => {
    const out: ChatTransformEvent[] = []
    buffer += content
    while (buffer.length > 0) {
      if (inThink) {
        const close = buffer.indexOf(CLOSE_TAG)
        if (close === -1) {
          // All thinking — emit everything but a possible split close-tag.
          if (buffer.length > CLOSE_HOLD) {
            out.push({ type: 'thinking', delta: buffer.slice(0, -CLOSE_HOLD) })
          }
          buffer = buffer.slice(-CLOSE_HOLD)
          break
        }
        if (close > 0) out.push({ type: 'thinking', delta: buffer.slice(0, close) })
        inThink = false
        buffer = buffer.slice(close + CLOSE_TAG.length)
      } else {
        const open = buffer.indexOf(OPEN_TAG)
        if (open === -1) {
          // Emit everything except a possible open-tag fragment cut mid-delta:
          // the last '<' whose suffix is a strict prefix of <think> is held
          // for the next frame. Ordinary text (no pending '<') flows through
          // in full within the same frame.
          let hold = 0
          const tag = buffer.lastIndexOf('<')
          if (tag !== -1 && buffer.length - tag <= OPEN_HOLD && OPEN_TAG.startsWith(buffer.slice(tag))) {
            hold = buffer.length - tag
          }
          if (buffer.length > hold) out.push({ type: 'answer', delta: buffer.slice(0, buffer.length - hold) })
          buffer = hold > 0 ? buffer.slice(-hold) : ''
          break
        }
        if (open > 0) out.push({ type: 'answer', delta: buffer.slice(0, open) })
        inThink = true
        buffer = buffer.slice(open + OPEN_TAG.length)
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
      // The held buffer is an unclosed tag fragment (dropped — it is not
      // answer text) or, when the stream ends mid-thinking, a fragment of
      // reasoning that was already streamed as earlier thinking deltas —
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
    if (payload.code !== 0) {
      const message = typeof payload.message === 'string' ? payload.message : 'RagFlow reported an error'
      return terminalError(message)
    }

    const out: ChatTransformEvent[] = []
    const sessionId = payload.data?.session_id
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
