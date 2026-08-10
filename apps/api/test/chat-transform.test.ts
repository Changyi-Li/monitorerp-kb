import { describe, expect, it } from 'vitest'
import { createCompletionTransform, type ChatTransformEvent } from '../src/chat/transform.js'

// RagFlow agent SSE frames (research #20 wire shape): `event:` + `data:`
// lines; the stream ends with `data: [DONE]`. These builders script the
// frame sequences the transform consumes.

const message = (content: string, sessionId?: string): string => {
  const frameData: Record<string, unknown> = { content }
  if (sessionId !== undefined) frameData['session_id'] = sessionId
  return `event: message\ndata: ${JSON.stringify({ code: 0, data: frameData })}`
}

const messageEnd = (sessionId?: string): string => {
  const frameData: Record<string, unknown> = { reference: { chunks: {} } }
  if (sessionId !== undefined) frameData['session_id'] = sessionId
  return `event: message_end\ndata: ${JSON.stringify({ code: 0, data: frameData })}`
}

const nodeFinished = (): string => `event: node_finished\ndata: ${JSON.stringify({ code: 0, data: {} })}`

const doneFrame = (): string => 'data: [DONE]'

const rejected = (messageText: string): string =>
  `event: message\ndata: ${JSON.stringify({ code: 102, message: messageText })}`

// Feeds every frame and collects the events.
const allEvents = (transform: { feed: (f: string) => ChatTransformEvent[] }, frames: string[]): ChatTransformEvent[] =>
  frames.flatMap((f) => transform.feed(f))

describe('completion transform — <think> stripping', () => {
  it('strips a complete <think> block inside one delta', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>Reasoning here.</think>The leave policy allows 21 days.'))).toEqual([
      { type: 'answer', delta: 'The leave policy allows 21 days.' },
    ])
  })

  it('keeps the thinking phase out of the answer across frames', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>Step one'))).toEqual([])
    expect(t.feed(message(' two.'))).toEqual([])
    expect(t.feed(message('</think>Here is the'))).toEqual([{ type: 'answer', delta: 'Here is the' }])
    expect(t.feed(message(' answer.'))).toEqual([{ type: 'answer', delta: ' answer.' }])
  })

  it('handles an open tag split across deltas', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('Answer starts. <thi'))).toEqual([{ type: 'answer', delta: 'Answer starts. ' }])
    expect(t.feed(message('nk>hidden reasoning'))).toEqual([])
    expect(t.feed(message('</think>'))).toEqual([])
    expect(t.feed(message(' visible answer'))).toEqual([{ type: 'answer', delta: ' visible answer' }])
  })

  it('handles a close tag split across deltas', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>reasoning text</thi'))).toEqual([])
    expect(t.feed(message('nk>Answer text.'))).toEqual([{ type: 'answer', delta: 'Answer text.' }])
  })

  it('strips multiple think blocks within one delta', () => {
    const t = createCompletionTransform({ lazy: false })
    expect(t.feed(message('<think>a</think>One<think>b</think>Two'))).toEqual([
      { type: 'answer', delta: 'One' },
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
    expect(allEvents(t, frames)).toEqual([
      { type: 'session', id: 'ragflow-session-9' },
      { type: 'answer', delta: 'Leave is capped at 21 days per year [1].' },
      { type: 'done' },
    ])
  })
})
