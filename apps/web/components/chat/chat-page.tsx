"use client";

import { Plus, Send, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  listChatSessions,
  streamCompletion,
  titleFromMessage,
  type ChatSessionSummary,
} from "@/lib/chat";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
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
          } else if (event.type === "answer") {
            patchAssistant((m) => ({ ...m, content: m.content + event.delta }));
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
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {message.content}
        {message.streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-foreground/70 motion-safe:animate-pulse" aria-hidden />
        )}
      </div>
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
