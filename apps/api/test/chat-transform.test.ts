import { describe, expect, it } from 'vitest'
import {
  createCompletionTransform,
  normalizeAnswerMarkers,
  splitThinking,
  type ChatTransformEvent,
} from '../src/chat/transform.js'
import { realCompletionFrame } from './ragflow-wire.js'

// Real RagFlow agent SSE frames (captured live from the deployed agent on
// 2026-08-10, bug #29): a single `data:` line whose JSON is
// {event, message_id, task_id, data, session_id}. Success frames carry NO
// `code` field — that envelope belongs to the dataset API, not the agent
// stream; the transform must not treat its absence as an error. The stream
// ends with `data: [DONE]`. Frames are built by the shared wire helper so
// they can never drift from the stub's.
const message = (content: string, sessionId = 'session-1'): string =>
  realCompletionFrame('message', { content }, sessionId)

const messageEnd = (sessionId = 'session-1', reference?: unknown): string =>
  realCompletionFrame('message_end', { reference: reference ?? { chunks: {} } }, sessionId)

const nodeFinished = (sessionId = 'session-1'): string => realCompletionFrame('node_finished', {}, sessionId)

const doneFrame = (): string => 'data: [DONE]'

// Real RagFlow agent reasoning delimiters (issue #32): reasoning in the stream
// is gated by boolean flags on `message` frames — a leading
// {"content":"","start_to_think":true}, then reasoning tokens, then
// {"content":"","end_to_think":true} — NOT by <think> tags. Component-level
// reasoning also arrives in a `node_started`/`node_finished` frame's
// `data.thoughts`. Captured live 2026-08-10.
const thinkStart = (sessionId = 'session-1'): string =>
  realCompletionFrame('message', { content: '', start_to_think: true }, sessionId)
const thinkEnd = (sessionId = 'session-1'): string =>
  realCompletionFrame('message', { content: '', end_to_think: true }, sessionId)
const nodeThoughts = (thoughts: string, sessionId = 'session-1'): string =>
  realCompletionFrame('node_started', { thoughts }, sessionId)

// Rejections carry a numeric non-zero `code` with a string `message` (real
// RagFlow error bodies, e.g. {"code":103,"message":"..."}).
const rejected = (messageText: string): string =>
  `data:${JSON.stringify({ code: 103, message: messageText })}`

// Feeds every frame and collects the events.
const allEvents = (transform: { feed: (f: string) => ChatTransformEvent[] }, frames: string[]): ChatTransformEvent[] =>
  frames.flatMap((f) => transform.feed(f))

/** Joins every thinking delta — reasoning arrives in per-frame chunks. */
const thinkingText = (events: ChatTransformEvent[]): string =>
  events
    .filter((e): e is Extract<ChatTransformEvent, { type: 'thinking' }> => e.type === 'thinking')
    .map((e) => e.delta)
    .join('')

/** Joins every answer delta — the [ID:n] marker hold splits some deltas. */
const answerText = (events: ChatTransformEvent[]): string =>
  events
    .filter((e): e is Extract<ChatTransformEvent, { type: 'answer' }> => e.type === 'answer')
    .map((e) => e.delta)
    .join('')

describe('completion transform — answer content', () => {
  it('emits answer text immediately when there is no reasoning', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('plain tail'))).toEqual([{ type: 'answer', delta: 'plain tail' }])
  })

  it('treats a literal "<" as plain answer text', () => {
    // The stream delimits reasoning with start_to_think flags (issue #32), so
    // scanAnswer no longer parses tags — a "<" is never special.
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('x < 3 and y < 2'))).toEqual([{ type: 'answer', delta: 'x < 3 and y < 2' }])
  })
})

describe('completion transform — reasoning via start_to_think/end_to_think (real wire, issue #32)', () => {
  it('routes message content between the flags to thinking, the rest to answer', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [thinkStart(), message('Reasoning here.'), thinkEnd(), message('The leave policy allows 21 days.')])
    expect(thinkingText(events)).toBe('Reasoning here.')
    expect(answerText(events)).toBe('The leave policy allows 21 days.')
  })

  it('streams reasoning deltas token by token across many message frames', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      thinkStart(),
      message('Step one'),
      message(' two.'),
      message(' Done.'),
      thinkEnd(),
      message('Here is the'),
      message(' answer.'),
    ])
    expect(thinkingText(events)).toBe('Step one two. Done.')
    expect(answerText(events)).toBe('Here is the answer.')
  })

  it('treats content before any flag as answer (a stream that never thinks)', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [message('Plain answer, no reasoning.')])
    expect(answerText(events)).toBe('Plain answer, no reasoning.')
    expect(thinkingText(events)).toBe('')
  })

  it("surfaces a node frame's non-empty thoughts as a thinking delta before the stream", () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      nodeThoughts('⌛Give me a moment — starting from: the user query.'),
      thinkStart(),
      message('Reasoning.'),
      thinkEnd(),
      message('Answer.'),
    ])
    // Component-level thoughts lead, then the streamed reasoning.
    expect(thinkingText(events)).toBe('⌛Give me a moment — starting from: the user query.Reasoning.')
    expect(answerText(events)).toBe('Answer.')
  })

  it('ignores empty thoughts fields', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [nodeThoughts(''), message('Answer.')])
    expect(thinkingText(events)).toBe('')
    expect(answerText(events)).toBe('Answer.')
  })

  it('does not rewrite [ID:n] citation markers inside reasoning', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      thinkStart(),
      message('Consider [ID:19] as a candidate.'),
      thinkEnd(),
      message('Answer [ID:19].'),
    ])
    // Reasoning is emitted raw — markers are NOT rewritten inside thinking.
    expect(thinkingText(events)).toBe('Consider [ID:19] as a candidate.')
    expect(answerText(events)).toBe('Answer [19].')
  })

  it('still rewrites [ID:n] markers in the answer after reasoning ends', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [thinkStart(), message('thinking'), thinkEnd(), message('Leave is capped at 21 days [ID:19].')])
    expect(answerText(events)).toBe('Leave is capped at 21 days [19].')
  })

  it('emits a session event from a reasoning stream in lazy mode', () => {
    const t = createCompletionTransform({ lazy: true })
    const events = allEvents(t, [
      thinkStart('ragflow-session-7'),
      message('thinking', 'ragflow-session-7'),
      thinkEnd('ragflow-session-7'),
      message('answer', 'ragflow-session-7'),
      doneFrame(),
    ])
    expect(events.filter((e) => e.type !== 'thinking').map((e) => e.type)).toEqual([
      'session',
      'answer',
      'done',
    ])
    expect(thinkingText(events)).toBe('thinking')
  })

  it('replays the real captured "hi" stream: thoughts → reasoning → answer → done', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      realCompletionFrame('workflow_started', { inputs: {} }, 'session-1'),
      realCompletionFrame('node_started', { thoughts: '' }, 'session-1'),
      realCompletionFrame('node_finished', { outputs: {} }, 'session-1'),
      nodeThoughts('⌛Give me a moment—starting from: \n\nThe user query is hi.', 'session-1'),
      realCompletionFrame('node_started', { thoughts: '' }, 'session-1'),
      thinkStart('session-1'),
      message('The'),
      message(' user'),
      message(' is just greeting me.'),
      thinkEnd('session-1'),
      message('## Answer\n\nHello!'),
      realCompletionFrame('message_end', { attachment: {} }, 'session-1'),
      realCompletionFrame('workflow_finished', { outputs: {} }, 'session-1'),
      doneFrame(),
    ])
    expect(events.filter((e) => e.type !== 'thinking').map((e) => e.type)).toEqual(['answer', 'done'])
    expect(thinkingText(events)).toBe('⌛Give me a moment—starting from: \n\nThe user query is hi.The user is just greeting me.')
    expect(answerText(events)).toBe('## Answer\n\nHello!')
  })
})

describe('completion transform — events', () => {
  it('emits a leading session event once with the upstream session id in lazy mode', () => {
    const t = createCompletionTransform({ lazy: true })
    expect(t.feed(message('', 'ragflow-session-1'))).toEqual([{ type: 'session', id: 'ragflow-session-1' }])
    expect(t.feed(message('Hi there', 'ragflow-session-1'))).toEqual([{ type: 'answer', delta: 'Hi there' }])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })

  it('emits session from a message_end frame when no message frame carried it', () => {
    const t = createCompletionTransform({ lazy: true })
    expect(t.feed(messageEnd('ragflow-session-2'))).toEqual([{ type: 'session', id: 'ragflow-session-2' }])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })

  it('never emits a session event when resuming an existing session', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Follow up', 'ragflow-session-1'))).toEqual([{ type: 'answer', delta: 'Follow up' }])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })

  it('ignores message_end and node_finished frames (citations dropped this slice)', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Answer text.'))).toEqual([{ type: 'answer', delta: 'Answer text.' }])
    expect(t.feed(messageEnd())).toEqual([])
    expect(t.feed(nodeFinished())).toEqual([])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })

  it('keeps all reasoning when the stream ends before end_to_think', () => {
    const t = createCompletionTransform({ lazy: false })
    // end_to_think never arrives — reasoning is emitted as it streams, so
    // nothing is truncated from the reconstructed thinking (issue #32).
    const events = allEvents(t, [thinkStart(), message('thinking text'), doneFrame()])
    expect(thinkingText(events)).toBe('thinking text')
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('emits done on [DONE] and ignores later frames', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('tail'))).toEqual([{ type: 'answer', delta: 'tail' }])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
    expect(t.feed(message('ignored after done'))).toEqual([])
    expect(t.feed(doneFrame())).toEqual([])
  })
})

describe('completion transform — errors', () => {
  it('emits a terminal error event for a non-zero code frame', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(rejected('Agent not found.'))).toEqual([
      { type: 'error', code: 'upstream_error', message: 'Agent not found.' },
    ])
    expect(t.feed(message('ignored after error'))).toEqual([])
  })

  it('emits a terminal error event for an unparseable frame', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed('event: message\ndata: <html>proxy error</html>')).toEqual([
      { type: 'error', code: 'upstream_error', message: 'RagFlow returned an unparseable stream frame' },
    ])
    expect(t.feed(doneFrame())).toEqual([])
  })

  it('emits a terminal error event when a frame has no data', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed('event: message')).toEqual([
      { type: 'error', code: 'upstream_error', message: 'RagFlow returned an unparseable stream frame' },
    ])
  })

  it('never emits session when the first frame is an error', () => {
    const t = createCompletionTransform({ lazy: true })
    expect(t.feed(rejected('Agent not found.'))).toEqual([
      { type: 'error', code: 'upstream_error', message: 'Agent not found.' },
    ])
  })
})

// Citation fixtures per research #20, on the REAL agent wire (issue #30):
// the LIVE shape is `reference: {chunks: {<citation id>: {content,
// document_id, document_name, dataset_id, positions}}}` from message_end
// where the map key is an ARBITRARY integer the agent cites as [ID:<key>]
// (captured 2026-08-10 — keys 19/21/25/34/41/…, never ordinals); the
// STORED-HISTORY shape is a LIST of {citation_id, content, document_id,
// document_name, id, positions} items whose `citation_id` is that same key.
const LIVE_REFERENCE = {
  chunks: {
    '19': {
      content: 'Leave is capped at 21 days per year.',
      document_id: 'ragflow-doc-1',
      document_name: 'Leave Policy.md',
      dataset_id: 'ds',
      positions: [[3, 0.1, 0.2, 0.8, 0.05]],
    },
    '41': {
      content: 'It resets every calendar year.',
      document_id: 'ragflow-doc-2',
      document_name: 'Handbook.pdf',
      dataset_id: 'ds',
      positions: [],
    },
  },
}

const HISTORY_REFERENCE = [
  {
    citation_id: '19',
    content: 'Submit the Purchase Arrivals form within two business days.',
    document_id: 'ragflow-doc-1',
    document_name: 'Leave Policy.md',
    id: 'chunk-1',
    positions: [[1, 0.0, 0.1, 0.5, 0.2]],
  },
  {
    citation_id: '41',
    content: 'Late submissions require written approval.',
    document_id: 'ragflow-doc-2',
    document_name: 'Handbook.pdf',
    id: 'chunk-2',
    positions: [],
  },
]

/** Maps 'ragflow-doc-1' to a managed document; everything else is external. */
const fakeLookup = (ragflowDocumentId: string): string | null =>
  ragflowDocumentId === 'ragflow-doc-1' ? 'our-doc-1' : null

describe('completion transform — citations', () => {
  it('normalizes the live chunks-object shape and maps document ids via the lookup', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    expect(t.feed(messageEnd(undefined, LIVE_REFERENCE))).toEqual([
      {
        type: 'references',
        items: [
          {
            n: 19,
            content: 'Leave is capped at 21 days per year.',
            document_name: 'Leave Policy.md',
            page: 3,
            ragflow_document_id: 'ragflow-doc-1',
            document_id: 'our-doc-1',
          },
          {
            n: 41,
            content: 'It resets every calendar year.',
            document_name: 'Handbook.pdf',
            page: null,
            ragflow_document_id: 'ragflow-doc-2',
            document_id: null,
          },
        ],
      },
    ])
  })

  it('normalizes the stored-history list shape with citation_id as n', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    expect(t.feed(messageEnd(undefined, HISTORY_REFERENCE))).toEqual([
      {
        type: 'references',
        items: [
          {
            n: 19,
            content: 'Submit the Purchase Arrivals form within two business days.',
            document_name: 'Leave Policy.md',
            page: 1,
            ragflow_document_id: 'ragflow-doc-1',
            document_id: 'our-doc-1',
          },
          {
            n: 41,
            content: 'Late submissions require written approval.',
            document_name: 'Handbook.pdf',
            page: null,
            ragflow_document_id: 'ragflow-doc-2',
            document_id: null,
          },
        ],
      },
    ])
  })

  it('does not resolve document ids without an injected lookup', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = t.feed(messageEnd(undefined, LIVE_REFERENCE))
    const items = events[0]?.type === 'references' ? events[0].items : []
    expect(items.map((c) => c.document_id)).toEqual([null, null])
  })

  it('skips citation items without a document id', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    const reference = {
      chunks: {
        '19': { content: 'kept', document_id: 'ragflow-doc-1', document_name: 'A.md', positions: [] },
        '41': { content: 'dropped — no document_id', document_name: 'B.md', positions: [] },
      },
    }
    const events = t.feed(messageEnd(undefined, reference))
    expect(events).toEqual([
      { type: 'references', items: [expect.objectContaining({ n: 19, document_id: 'our-doc-1' })] },
    ])
  })

  it('uses the stored item\'s citation_id as n — never list order (issue #30)', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    const reference = [
      { citation_id: '19', content: 'a', document_id: 'ragflow-doc-1', document_name: 'A.md', positions: [] },
      { citation_id: '41', content: 'b', document_id: 'ragflow-doc-2', document_name: 'B.md', positions: [] },
    ]
    const events = t.feed(messageEnd(undefined, reference))
    expect(events).toEqual([
      {
        type: 'references',
        items: [expect.objectContaining({ n: 19 }), expect.objectContaining({ n: 41 })],
      },
    ])
  })

  it('accepts a JSON-number citation_id as well as the real wire\'s string form', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    const reference = [
      { citation_id: 19, content: 'a', document_id: 'ragflow-doc-1', document_name: 'A.md', positions: [] },
      { citation_id: '41', content: 'b', document_id: 'ragflow-doc-2', document_name: 'B.md', positions: [] },
    ]
    const events = t.feed(messageEnd(undefined, reference))
    expect(events).toEqual([
      {
        type: 'references',
        items: [expect.objectContaining({ n: 19 }), expect.objectContaining({ n: 41 })],
      },
    ])
  })

  it('drops stored items whose citation_id could never match a marker', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    const reference = [
      {
        citation_id: 'c1', // non-numeric — no [ID:n] marker can ever match it
        content: 'dropped',
        document_id: 'ragflow-doc-1',
        document_name: 'A.md',
        positions: [],
      },
      { citation_id: '41', content: 'kept', document_id: 'ragflow-doc-2', document_name: 'B.md', positions: [] },
    ]
    const events = t.feed(messageEnd(undefined, reference))
    expect(events).toEqual([{ type: 'references', items: [expect.objectContaining({ n: 41 })] }])
  })

  it('emits no references event for an absent or empty reference', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    expect(t.feed(messageEnd())).toEqual([])
    expect(t.feed(messageEnd(undefined, { chunks: {} }))).toEqual([])
    expect(t.feed(messageEnd(undefined, null))).toEqual([])
  })

  it('emits references once, after the answer and before done', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    const events = [
      ...t.feed(message('The policy [ID:1].')),
      ...t.feed(messageEnd(undefined, LIVE_REFERENCE)),
      ...t.feed(messageEnd(undefined, LIVE_REFERENCE)), // a second message_end is ignored
      ...t.feed(doneFrame()),
    ]
    expect(events.map((e) => e.type)).toEqual(['answer', 'references', 'done'])
  })
})

describe('completion transform — [ID:n] marker rewriting (issue #30)', () => {
  it('rewrites a complete [ID:n] marker to [n] in the answer', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Leave is capped at 21 days [ID:19].'))).toEqual([
      { type: 'answer', delta: 'Leave is capped at 21 days [19].' },
    ])
  })

  it('rewrites adjacent markers in the same delta', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Create via Save As [ID:19][ID:41].'))).toEqual([
      { type: 'answer', delta: 'Create via Save As [19][41].' },
    ])
  })

  it('rewrites a marker split across deltas (prefix held)', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [message('Register new components [ID:'), message('19].')])
    expect(answerText(events)).toBe('Register new components [19].')
  })

  it('rewrites a marker whose digits split across deltas', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [message('See the part register [ID:1'), message('9]'), message(' for details.')])
    expect(answerText(events)).toBe('See the part register [19] for details.')
  })

  it('does not rewrite bracket text that is not an [ID:n] marker', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('See [IDs: 3] and [ID:x] and [ID:] text.'))).toEqual([
      { type: 'answer', delta: 'See [IDs: 3] and [ID:x] and [ID:] text.' },
    ])
  })

  it('drops an incomplete marker fragment when the stream dies at [DONE]', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Tail cut mid-marker [ID:4'))).toEqual([{ type: 'answer', delta: 'Tail cut mid-marker ' }])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })
})

describe('normalizeAnswerMarkers — stored-history content (issue #30)', () => {
  it('rewrites every [ID:n] marker in a whole string', () => {
    expect(normalizeAnswerMarkers('Per the register [ID:19], delete [ID:41] and [ID:172].')).toBe(
      'Per the register [19], delete [41] and [172].',
    )
  })

  it('leaves strings without markers untouched', () => {
    expect(normalizeAnswerMarkers('Plain answer without citations.')).toBe('Plain answer without citations.')
  })
})

describe('splitThinking — stored history content', () => {
  it('splits a complete think block from the answer', () => {
    expect(splitThinking('<think>Reasoning here.</think>The answer.')).toEqual({
      thinking: 'Reasoning here.',
      answer: 'The answer.',
    })
  })

  it('concatenates multiple think blocks', () => {
    expect(splitThinking('<think>a</think>One<think>b</think>Two')).toEqual({ thinking: 'ab', answer: 'OneTwo' })
  })

  it('counts an unclosed think block as reasoning', () => {
    expect(splitThinking('Lead<think>unclosed')).toEqual({ thinking: 'unclosed', answer: 'Lead' })
  })

  it('leaves content without think tags untouched', () => {
    expect(splitThinking('Plain answer.')).toEqual({ thinking: '', answer: 'Plain answer.' })
  })
})

describe('completion transform — full stream shape', () => {
  it('emits session → thinking → answer → done for a scripted lazy stream', () => {
    const t = createCompletionTransform({ lazy: true })
    const frames = [
      thinkStart('ragflow-session-9'),
      message('The user asks', 'ragflow-session-9'),
      message(' about leave policy.', 'ragflow-session-9'),
      thinkEnd('ragflow-session-9'),
      message('Leave is capped at 21 days per year [ID:19].', 'ragflow-session-9'),
      messageEnd('ragflow-session-9'),
      nodeFinished(),
      doneFrame(),
    ]
    const events = allEvents(t, frames)
    expect(events.filter((e) => e.type !== 'thinking')).toEqual([
      { type: 'session', id: 'ragflow-session-9' },
      { type: 'answer', delta: 'Leave is capped at 21 days per year [19].' },
      { type: 'done' },
    ])
    expect(thinkingText(events)).toBe('The user asks about leave policy.')
  })
})

describe('completion transform — real RagFlow frame shape (bug #29)', () => {
  it('streams a real-shaped lazy stream end to end: session → answer → done', () => {
    const t = createCompletionTransform({ lazy: true })
    const events = allEvents(t, [
      realCompletionFrame('workflow_started', {}, 'real-session-1'),
      message('Hello! I am your assistant.', 'real-session-1'),
      messageEnd('real-session-1'),
      nodeFinished('real-session-1'),
      doneFrame(),
    ])
    expect(events.filter((e) => e.type !== 'thinking')).toEqual([
      { type: 'session', id: 'real-session-1' },
      { type: 'answer', delta: 'Hello! I am your assistant.' },
      { type: 'done' },
    ])
  })

  it('does not treat a code-less frame as an error — real success frames have no code field', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('plain text'))).toEqual([{ type: 'answer', delta: 'plain text' }])
    expect(t.feed(messageEnd())).toEqual([])
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })
})
