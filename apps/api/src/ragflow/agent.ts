import type { Config } from '../config.js'
import { expectCodeZero, guardedFetch, parseUpstreamJson, RagflowError } from './client.js'

export interface AgentCompletionInput {
  /** The RagFlow session id; null means "auto-create a session" (lazy create). */
  sessionId: string | null
  query: string
}

export interface RagflowSessionPayload {
  /** Conversation history embedded in the session object (research #20). */
  message?: unknown
}

export interface AgentClient {
  /**
   * Opens RagFlow's agent completion SSE stream. The response body is the raw
   * upstream stream — the caller consumes it and applies the chat streaming
   * transform. A non-2xx upstream (or an unreachable RagFlow) throws
   * RagflowError; rejections that RagFlow reports in-stream (HTTP 200 with a
   * non-zero `code` frame) surface through the stream instead.
   */
  completions(input: AgentCompletionInput): Promise<Response>
  /**
   * Fetches one session live from RagFlow (`?id=&dsl=false` — the DSL payload
   * balloons to ~2 MB, research #20). Returns the session object; its
   * conversation history is embedded as `message[]` inside it.
   */
  fetchSession(sessionId: string): Promise<RagflowSessionPayload>
  /** Deletes the session from RagFlow (`{ids, delete_all}` body, research #20). */
  deleteSession(sessionId: string): Promise<void>
}

/**
 * HTTP client for the RagFlow agent (a different API surface than the
 * dataset/document client — /api/v1/agents/... per research #20). The agent
 * is fixed at deployment (the app never manages agents), so the client
 * captures its id. It reuses the dataset client's shared primitives:
 * guardedFetch, parseUpstreamJson, expectCodeZero, RagflowError, and the
 * same auth header convention.
 */
export function createAgentClient(config: Config): AgentClient {
  const base = new URL(config.ragflowUrl)
  const authHeader = `Bearer ${config.ragflowApiKey}`
  const completionsUrl = () => new URL('/api/v1/agents/chat/completions', base)
  const sessionsUrl = () => new URL(`/api/v1/agents/${config.ragflowAgentId}/sessions`, base)

  return {
    async completions({ sessionId, query }) {
      // exactOptionalPropertyTypes: `session_id` must be omitted entirely for
      // lazy session auto-create — sending it null would create a session
      // named "None" upstream (research #20).
      const body: Record<string, unknown> = {
        agent_id: config.ragflowAgentId,
        query,
        stream: true,
      }
      if (sessionId !== null) body['session_id'] = sessionId
      const upstream = await guardedFetch(
        completionsUrl(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow completion failed with status ${upstream.status}`, upstream.status)
      }
      return upstream
    },

    async fetchSession(sessionId) {
      const url = sessionsUrl()
      url.searchParams.set('id', sessionId)
      // Always pass dsl=false — the canvas DSL payload balloons each session
      // to ~2 MB (research #20).
      url.searchParams.set('dsl', 'false')
      const upstream = await guardedFetch(url, { method: 'GET' }, authHeader)
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow session fetch failed with status ${upstream.status}`, upstream.status)
      }
      const payload = (await parseUpstreamJson(upstream)) as { code?: number; data?: RagflowSessionPayload }
      if (payload.code !== 0) {
        throw new RagflowError('RagFlow session fetch was rejected')
      }
      return payload.data ?? {}
    },

    async deleteSession(sessionId) {
      const upstream = await guardedFetch(
        sessionsUrl(),
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          // Real RagFlow deletes agent sessions with `ids` and `delete_all`
          // in the JSON body (research #20).
          body: JSON.stringify({ ids: [sessionId], delete_all: false }),
        },
        authHeader,
      )
      if (!upstream.ok) {
        throw new RagflowError(`RagFlow session delete failed with status ${upstream.status}`, upstream.status)
      }
      await expectCodeZero(upstream, 'RagFlow session delete was rejected')
    },
  }
}
