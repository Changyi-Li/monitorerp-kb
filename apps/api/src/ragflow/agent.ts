import type { Config } from '../config.js'
import { guardedFetch, RagflowError } from './client.js'

export interface AgentCompletionInput {
  /** The RagFlow session id; null means "auto-create a session" (lazy create). */
  sessionId: string | null
  query: string
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
}

/**
 * HTTP client for the RagFlow agent (a different API surface than the
 * dataset/document client — /api/v1/agents/... per research #20). The agent
 * is fixed at deployment (the app never manages agents), so the client
 * captures its id. It reuses the dataset client's shared primitives:
 * guardedFetch, RagflowError, and the same auth header convention.
 */
export function createAgentClient(config: Config): AgentClient {
  const base = new URL(config.ragflowUrl)
  const authHeader = `Bearer ${config.ragflowApiKey}`
  const completionsUrl = () => new URL('/api/v1/agents/chat/completions', base)

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
  }
}
