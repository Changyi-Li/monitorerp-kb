// The core streaming logic: a pure, framework-agnostic transform that
// consumes RagFlow agent SSE frames and emits the normalized event contract
// (chatbot spec #23; this slice emits session/answer/done only — reasoning
// and citations are dropped). Reasoning arrives inline as literal
// <think>…</think> tags that may span multiple deltas (research #20); the
// transform strips them statefully so the client never parses tags.
//
// The transform is deliberately DB- and HTTP-free: the route wires it to real
// RagFlow SSE, and the unit test drives it with scripted frames.

export type ChatTransformEvent =
  | { type: 'session'; id: string }
  | { type: 'answer'; delta: string }
  | { type: 'done' }
  | { type: 'error'; code: 'upstream_error'; message: string }

export interface CompletionTransform {
  /** Feeds one complete SSE frame and returns the events it produced. */
  feed(frame: string): ChatTransformEvent[]
}

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
  data?: { content?: unknown; session_id?: unknown }
}

export function createCompletionTransform(options: { lazy: boolean }): CompletionTransform {
  let finished = false
  let sessionEmitted = false
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
          // All thinking — discard everything but a possible split close-tag.
          buffer = buffer.slice(-CLOSE_HOLD)
          break
        }
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
      // The held buffer is only ever an unclosed tag fragment or thinking —
      // both correctly dropped at stream end.
      finished = true
      return [{ type: 'done' }]
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
    return out
  }

  // Note: a stream that ends without [DONE] simply stops — the held fragment
  // (an unclosed tag or thinking) is never answer text, so there is nothing
  // to flush on end-of-stream.

  return { feed }
}
