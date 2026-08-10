"use client";

import { ChevronDown, ExternalLink, Plus, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  listChatSessions,
  streamCompletion,
  titleFromMessage,
  type ChatCitation,
  type ChatSessionSummary,
} from "@/lib/chat";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  thinking?: string;
  citations?: ChatCitation[];
}

const EMPTY_MESSAGES: ChatMessage[] = [];

const newId = (): string => crypto.randomUUID();

/**
 * The chat surface (spec #23, variant B layout). This slice: sidebar of the
 * caller's sessions, lazy session creation on the first message, and answers
 * streaming token by token through the normalized SSE contract. Message
 * history is not fetched in this slice — each session's thread lives in this
 * component for the page session.
 */
export function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Map<string, ChatMessage[]>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The key of the thread the in-flight completion writes into ("new" until
  // the lazy session event re-homes it under the created session id).
  const threadKeyRef = useRef<string>("new");

  // Initial load: the session list, preselected from ?s=.
  useEffect(() => {
    let cancelled = false;
    listChatSessions()
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 401) {
          router.replace("/auth/sign-in");
          return;
        }
        setSessions(body.items);
        const param = searchParams.get("s");
        const match = body.items.find((s) => s.id === param);
        setActiveId(match?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load chat sessions.");
      });
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  const activeThread = useMemo(
    () => (activeId === null ? threads.get("new") ?? EMPTY_MESSAGES : threads.get(activeId) ?? EMPTY_MESSAGES),
    [threads, activeId],
  );

  // The thread auto-scrolls to the latest content as the answer streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [activeThread, streaming]);

  const refreshSessions = useCallback((): void => {
    listChatSessions()
      .then(({ status, body }) => {
        if (status === 200) setSessions(body.items);
      })
      .catch(() => {});
  }, []);

  const startNew = useCallback((): void => {
    if (streaming) return;
    setActiveId(null);
    setSendError(null);
    router.replace("/chat", { scroll: false });
  }, [router, streaming]);

  const select = useCallback(
    (id: string): void => {
      if (streaming) return;
      setActiveId(id);
      setSendError(null);
      router.replace(`/chat?s=${id}`, { scroll: false });
    },
    [router, streaming],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === "" || streaming) return;
      setStreaming(true);
      setSendError(null);
      threadKeyRef.current = activeId ?? "new";

      const userMsg: ChatMessage = { id: newId(), role: "user", content: trimmed };
      const assistantMsg: ChatMessage = { id: newId(), role: "assistant", content: "", streaming: true };
      setThreads((prev) => {
        const next = new Map(prev);
        const key = threadKeyRef.current;
        next.set(key, [...(next.get(key) ?? []), userMsg, assistantMsg]);
        return next;
      });

      const patchAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
        setThreads((prev) => {
          const next = new Map(prev);
          const key = threadKeyRef.current;
          const thread = next.get(key);
          if (thread === undefined) return prev;
          next.set(key, thread.map((m) => (m.id === assistantMsg.id ? fn(m) : m)));
          return next;
        });
      };

      try {
        await streamCompletion(activeId === null ? { query: trimmed } : { session_id: activeId, query: trimmed }, (event) => {
          if (event.type === "session") {
            // Lazily created — pin the URL and re-home the thread under the
            // session id; the sidebar shows it immediately.
            threadKeyRef.current = event.id;
            setActiveId(event.id);
            router.replace(`/chat?s=${event.id}`, { scroll: false });
            setThreads((prev) => {
              const next = new Map(prev);
              const thread = next.get("new");
              if (thread !== undefined) {
                next.delete("new");
                next.set(event.id, thread);
              }
              return next;
            });
            setSessions((prev) => [
              {
                id: event.id,
                title: titleFromMessage(trimmed),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              ...prev,
            ]);
          } else if (event.type === "thinking") {
            patchAssistant((m) => ({ ...m, thinking: (m.thinking ?? "") + event.delta }));
          } else if (event.type === "answer") {
            patchAssistant((m) => ({ ...m, content: m.content + event.delta }));
          } else if (event.type === "references") {
            patchAssistant((m) => ({ ...m, citations: event.items }));
          } else if (event.type === "error") {
            setSendError(event.message);
          }
        });
      } catch {
        setSendError("Could not reach the agent. Try again.");
      } finally {
        patchAssistant((m) => ({ ...m, streaming: false }));
        setStreaming(false);
        refreshSessions();
      }
    },
    [activeId, router, refreshSessions, streaming],
  );

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar/40">
        <div className="p-3">
          <Button className="w-full justify-start" onClick={startNew} disabled={streaming}>
            <Plus aria-hidden /> New chat
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loadError !== null && <p className="px-2 py-4 text-sm text-destructive">{loadError}</p>}
          {loadError === null && sessions.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">No chats yet.</p>
          )}
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={s.id === activeId ? "true" : undefined}
                  onClick={() => select(s.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    s.id === activeId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.title}</p>
                    <p className="text-xs text-muted-foreground">{relativeTime(s.updated_at)}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-6 py-3">
          <h1 className="truncate text-sm font-semibold">{activeSession?.title ?? "New chat"}</h1>
          {activeSession !== null && (
            <p className="text-xs text-muted-foreground">Updated {relativeTime(activeSession.updated_at)}</p>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
            {activeThread.length === 0 ? (
              <EmptyState />
            ) : (
              activeThread.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
            <div ref={bottomRef} />
          </div>
        </div>
        <div className="border-t px-6 py-3">
          <div className="mx-auto max-w-3xl">
            {sendError !== null && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {sendError}
              </p>
            )}
            <Composer onSend={(text) => void send(text)} disabled={streaming} />
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 pt-16 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-5" aria-hidden />
      </div>
      <h2 className="text-base font-semibold">Ask about the knowledge base</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Answers stream in as they are generated. Your chats are private to you.
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const [focused, setFocused] = useState<number | null>(null);
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  // Clicking an inline [n] chip toggles that source's card directly under
  // the answer; clicking another marker swaps the shown card.
  const handleCite = (n: number): void => setFocused((cur) => (cur === n ? null : n));
  const focusedCitation = message.citations?.find((c) => c.n === focused);

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <ThinkingPane thinking={message.thinking} streaming={message.streaming} />
        <div className="text-sm leading-relaxed">
          <AnswerWithCitations content={message.content} citations={message.citations} onCite={handleCite} />
          {message.streaming && message.content !== "" && (
            <span className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-foreground/70 motion-safe:animate-pulse" aria-hidden />
          )}
        </div>
        {focusedCitation !== undefined && (
          <div className="mt-3">
            <CitationCard citation={focusedCitation} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible reasoning pane — collapsed by default; "Show thinking" reveals
 * it. While the answer is streaming with no reasoning yet, it shows a
 * "Thinking…" indicator instead of a toggle.
 */
function ThinkingPane({ thinking, streaming }: { thinking?: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const empty = (thinking ?? "") === "" && !streaming;
  if (empty) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open ? "" : "-rotate-90")} aria-hidden />
        {streaming && (thinking ?? "") === "" ? (
          <span className="flex items-center gap-1">
            Thinking
            <span className="inline-flex gap-0.5">
              <span className="size-1 rounded-full bg-current motion-safe:animate-bounce [animation-delay:-0.3s]" />
              <span className="size-1 rounded-full bg-current motion-safe:animate-bounce [animation-delay:-0.15s]" />
              <span className="size-1 rounded-full bg-current motion-safe:animate-bounce" />
            </span>
          </span>
        ) : (
          <span>{open ? "Hide thinking" : "Show thinking"}</span>
        )}
      </button>
      {open && (thinking ?? "") !== "" && (
        <p className="whitespace-pre-wrap border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">{thinking}</p>
      )}
    </div>
  );
}

/** Renders inline [n] markers as clickable chips; unmatched markers are inert. */
function AnswerWithCitations({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations?: ChatCitation[];
  onCite: (n: number) => void;
}) {
  const byOrdinal = new Map((citations ?? []).map((c) => [c.n, c]));
  const parts = content.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, idx) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (match === null) return <span key={idx}>{part}</span>;
        const n = Number(match[1]);
        const cite = byOrdinal.get(n);
        return (
          <button
            key={idx}
            type="button"
            onClick={() => onCite(n)}
            disabled={cite === undefined}
            aria-label={cite !== undefined ? `Source ${n}: ${cite.document_name}` : `Source ${n}`}
            className={cn(
              "mx-0.5 inline-flex h-4 min-w-4 -translate-y-1.5 items-center justify-center rounded-full px-1 align-baseline text-[10px] font-semibold tabular-nums transition-colors",
              cite !== undefined
                ? "bg-primary/15 text-primary hover:bg-primary hover:text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {n}
          </button>
        );
      })}
    </>
  );
}

/**
 * One cited source — the card LEADS with the chunk passage and page, then
 * shows the document name; "Open full document" appears only for our docs.
 */
function CitationCard({ citation }: { citation: ChatCitation }) {
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-left">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary tabular-nums">
          {citation.n}
        </span>
        <p className="min-w-0 flex-1 border-l-2 pl-2 text-sm leading-relaxed text-muted-foreground">
          {citation.content}
        </p>
        {citation.page !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">page {citation.page}</span>
        )}
      </div>
      <p className="mt-2 truncate text-sm font-medium" title={citation.document_name}>
        {citation.document_name}
      </p>
      {citation.document_id !== null && (
        <Link
          href={`/?doc=${citation.document_id}`}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          title="Open this document in the Documents screen"
        >
          Open full document
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/** Composer — Enter sends, Shift+Enter adds a newline; disabled while streaming. */
function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (text.trim() === "") return;
    onSend(text);
    setText("");
  };
  return (
    <div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:border-ring">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Ask about the knowledge base…"
        aria-label="Message"
        disabled={disabled}
        className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <Button size="icon" onClick={submit} disabled={disabled || text.trim() === ""} aria-label="Send message">
        <Send className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
