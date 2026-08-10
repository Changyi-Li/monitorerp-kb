import { describe, expect, it } from 'vitest'
import { createCompletionTransform, splitThinking, type ChatTransformEvent } from '../src/chat/transform.js'
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

// Rejections carry a numeric non-zero `code` with a string `message` (real
// RagFlow error bodies, e.g. {"code":103,"message":"..."}).
const rejected = (messageText: string): string =>
  `data:${JSON.stringify({ code: 103, message: messageText })}`

// Feeds every frame and collects the events.
const allEvents = (transform: { feed: (f: string) => ChatTransformEvent[] }, frames: string[]): ChatTransformEvent[] =>
  frames.flatMap((f) => transform.feed(f))

/** Joins every thinking delta — the tag-hold fragments chunk them unevenly. */
const thinkingText = (events: ChatTransformEvent[]): string =>
  events
    .filter((e): e is Extract<ChatTransformEvent, { type: 'thinking' }> => e.type === 'thinking')
    .map((e) => e.delta)
    .join('')

/** Joins every answer delta — the tag-hold fragments chunk them unevenly. */
const answerText = (events: ChatTransformEvent[]): string =>
  events
    .filter((e): e is Extract<ChatTransformEvent, { type: 'answer' }> => e.type === 'answer')
    .map((e) => e.delta)
    .join('')

describe('completion transform — thinking vs answer', () => {
  it('emits a thinking delta for the <think> block and an answer delta for the rest', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>Reasoning here.</think>The leave policy allows 21 days.'))).toEqual([
      { type: 'thinking', delta: 'Reasoning here.' },
      { type: 'answer', delta: 'The leave policy allows 21 days.' },
    ])
  })

  it('emits thinking deltas for the thinking phase and answer deltas for the rest', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      message('<think>Step one'),
      message(' two.'),
      message('</think>Here is the'),
      message(' answer.'),
    ])
    expect(answerText(events)).toBe('Here is the answer.')
    expect(thinkingText(events)).toBe('Step one two.')
  })

  it('handles an open tag split across deltas, thinking and answer both intact', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [
      message('Answer starts. <thi'),
      message('nk>hidden reasoning'),
      message('</think>'),
      message(' visible answer'),
    ])
    expect(answerText(events)).toBe('Answer starts.  visible answer')
    expect(thinkingText(events)).toBe('hidden reasoning')
  })

  it('handles a close tag split across deltas', () => {
    const t = createCompletionTransform({ lazy: false })
    const events = allEvents(t, [message('<think>reasoning text</thi'), message('nk>Answer text.')])
    expect(thinkingText(events)).toBe('reasoning text')
    expect(answerText(events)).toBe('Answer text.')
  })

  it('interleaves multiple think blocks within one delta', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>a</think>One<think>b</think>Two'))).toEqual([
      { type: 'thinking', delta: 'a' },
      { type: 'answer', delta: 'One' },
      { type: 'thinking', delta: 'b' },
      { type: 'answer', delta: 'Two' },
    ])
  })

  it('does not leak a trailing open-tag fragment into the answer', () => {
    const t = createCompletionTransform({ lazy: false })
    // '<thi' is a split open tag; the stream dies before it completes. Only
    // the fragment is held — the text before it is answer.
    expect(t.feed(message('partial answer<x<thi'))).toEqual([{ type: 'answer', delta: 'partial answer<x' }])
    // A frame that could not complete the tag (e.g. [DONE]) drops the fragment.
    expect(t.feed(doneFrame())).toEqual([{ type: 'done' }])
  })

  it('emits answer text immediately when no tag fragment is pending', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('plain tail'))).toEqual([{ type: 'answer', delta: 'plain tail' }])
  })

  it('does not hold back a literal "<" that is not a tag start', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('x < 3 and y < 2'))).toEqual([{ type: 'answer', delta: 'x < 3 and y < 2' }])
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

  it('emits the held thinking fragment when the stream ends mid-thinking', () => {
    const t = createCompletionTransform({ lazy: false })
    // The close tag never arrives; the held reasoning fragment must not be
    // truncated from the reconstructed thinking.
    const events = allEvents(t, [message('<think>thinking text'), doneFrame()])
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

// Citation fixtures per research #20: the LIVE shape is an object
// `reference: {chunks: {<ordinal>: {content, document_id, document_name,
// dataset_id, positions}}}` from message_end; the STORED-HISTORY shape is a
// LIST of `{citation_id, content, document_id, document_name, id,
// positions}` items.
const LIVE_REFERENCE = {
  chunks: {
    '1': {
      content: 'Leave is capped at 21 days per year.',
      document_id: 'ragflow-doc-1',
      document_name: 'Leave Policy.md',
      dataset_id: 'ds',
      positions: [[3, 0.1, 0.2, 0.8, 0.05]],
    },
    '2': {
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
    citation_id: 'c1',
    content: 'Submit the Purchase Arrivals form within two business days.',
    document_id: 'ragflow-doc-1',
    document_name: 'Leave Policy.md',
    id: 'chunk-1',
    positions: [[1, 0.0, 0.1, 0.5, 0.2]],
  },
  {
    citation_id: 'c2',
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
            n: 1,
            content: 'Leave is capped at 21 days per year.',
            document_name: 'Leave Policy.md',
            page: 3,
            ragflow_document_id: 'ragflow-doc-1',
            document_id: 'our-doc-1',
          },
          {
            n: 2,
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

  it('normalizes the stored-history list shape with 1-based ordinals', () => {
    const t = createCompletionTransform({ lazy: false, documentIdLookup: fakeLookup })
    expect(t.feed(messageEnd(undefined, HISTORY_REFERENCE))).toEqual([
      {
        type: 'references',
        items: [
          {
            n: 1,
            content: 'Submit the Purchase Arrivals form within two business days.',
            document_name: 'Leave Policy.md',
            page: 1,
            ragflow_document_id: 'ragflow-doc-1',
            document_id: 'our-doc-1',
          },
          {
            n: 2,
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
        '1': { content: 'kept', document_id: 'ragflow-doc-1', document_name: 'A.md', positions: [] },
        '2': { content: 'dropped — no document_id', document_name: 'B.md', positions: [] },
      },
    }
    const events = t.feed(messageEnd(undefined, reference))
    expect(events).toEqual([
      { type: 'references', items: [expect.objectContaining({ n: 1, document_id: 'our-doc-1' })] },
    ])
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
      ...t.feed(message('The policy [1].')),
      ...t.feed(messageEnd(undefined, LIVE_REFERENCE)),
      ...t.feed(messageEnd(undefined, LIVE_REFERENCE)), // a second message_end is ignored
      ...t.feed(doneFrame()),
    ]
    expect(events.map((e) => e.type)).toEqual(['answer', 'references', 'done'])
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
  it('emits session → answer deltas → done for a scripted lazy stream', () => {
    const t = createCompletionTransform({ lazy: true })
    const frames = [
      message('<think>The user asks', 'ragflow-session-9'),
      message(' about leave policy.</think>Leave is capped at 21 days per year [1].'),
      messageEnd('ragflow-session-9'),
      nodeFinished(),
      doneFrame(),
    ]
    const events = allEvents(t, frames)
    expect(events.filter((e) => e.type !== 'thinking')).toEqual([
      { type: 'session', id: 'ragflow-session-9' },
      { type: 'answer', delta: 'Leave is capped at 21 days per year [1].' },
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
