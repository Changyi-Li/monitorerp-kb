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
