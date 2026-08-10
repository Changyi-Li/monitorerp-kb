import { apiJson, type ApiErrorBody, type ApiResult } from "@/lib/api";

export interface ChatSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionListResult {
  items: ChatSessionSummary[];
  total: number;
  page: number;
  page_size: number;
}

export function listChatSessions(): Promise<ApiResult<ChatSessionListResult>> {
  return apiJson<ChatSessionListResult>("/api/chat/sessions");
}

/** Sidebar title from the first message — mirrors the API's derivation. */
export function titleFromMessage(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

// --- The normalized SSE contract (spec #23). The client is a dumb renderer
// and never parses <think> tags or raw citation shapes.

export interface ChatCitation {
  /** Matches the [n] marker in the answer. */
  n: number;
  /** The cited chunk passage — leads the source card. */
  content: string;
  document_name: string;
  page: number | null;
  ragflow_document_id: string;
  /** Our documents.id when the source is one of our Documents, else null. */
  document_id: string | null;
}

export type ChatStreamEvent =
  | { type: "session"; id: string }
  | { type: "thinking"; delta: string }
  | { type: "answer"; delta: string }
  | { type: "references"; items: ChatCitation[] }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

/**
 * POSTs a completion and drives the normalized events into `onEvent`.
 * Omit `session_id` to lazily create a session on the first message.
 * Transport-level failures throw; in-stream failures arrive as `error` events.
 */
export async function streamCompletion(
  body: { session_id?: string; query: string },
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new Error(payload?.error.message ?? "The request failed");
  }
  if (res.body === null) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseSseBlock(block);
        if (event !== null) onEvent(event);
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): ChatStreamEvent | null {
  let event = "message";
  let data: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (data === null) return null;
  let payload: { id?: string; delta?: string; code?: string; message?: string; items?: unknown };
  try {
    payload = JSON.parse(data) as typeof payload;
  } catch {
    return null; // a malformed frame is not worth crashing the thread over
  }
  switch (event) {
    case "session":
      return { type: "session", id: payload.id ?? "" };
    case "thinking":
      return { type: "thinking", delta: payload.delta ?? "" };
    case "answer":
      return { type: "answer", delta: payload.delta ?? "" };
    case "references":
      return { type: "references", items: parseReferences(payload.items) };
    case "done":
      return { type: "done" };
    case "error":
      return {
        type: "error",
        code: payload.code ?? "upstream_error",
        message: payload.message ?? "Something went wrong",
      };
    default:
      return null;
  }
}

function parseReferences(items: unknown): ChatCitation[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      n: typeof c.n === "number" ? c.n : 0,
      content: typeof c.content === "string" ? c.content : "",
      document_name: typeof c.document_name === "string" ? c.document_name : "",
      page: typeof c.page === "number" ? c.page : null,
      ragflow_document_id: typeof c.ragflow_document_id === "string" ? c.ragflow_document_id : "",
      document_id: typeof c.document_id === "string" ? c.document_id : null,
    }));
}
