"use client";

import { ChevronDown, ExternalLink, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { cloneElement, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import {
  deleteChatSession,
  getSessionMessages,
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

/**
 * The one open citation across the whole thread, identified by message AND
 * ordinal AND occurrence: an answer can cite the same source more than once
 * (issue #48), and two messages can cite the same source, so the open card is
 * anchored to the exact marker that was clicked. One card at a time — in
 * inline mode it renders at the marker (issue #48); in side panel mode the
 * same focus drives the docked panel (issue #49).
 */
interface CitationFocus {
  /** The message whose marker is open. */
  messageId: string;
  n: number;
  /** The marker's position among same-ordinal markers, in document order (1-based). */
  occ: number;
}

/** How citation chips open: inline at the marker (default) or in a docked side panel. */
type CitationMode = "inline" | "side";

/** The id of the citation card for a marker — the marker's aria-controls, in
 *  both inline and side panel mode, so it must come from one place. */
const citationCardId = (messageId: string, n: number, occ: number): string => `citation-card-${messageId}-${n}-${occ}`;

/** Whether two focus descriptors name the same marker (issue #49: the open
 *  card is anchored to the exact message + ordinal + occurrence). */
const sameFocus = (a: CitationFocus, b: CitationFocus): boolean =>
  a.messageId === b.messageId && a.n === b.n && a.occ === b.occ;

// App-scoped. Only the value "side" opts into the panel; anything else —
// missing, or "drawer" from the old prototype — means inline.
const CITATION_MODE_STORAGE_KEY = "citation-mode";

// The citation mode is an external store (localStorage, spec #47: device-local)
// read through useSyncExternalStore. A useState lazy initializer would
// re-read storage during hydration and render attributes the server HTML
// doesn't have — React 19 does NOT patch attribute mismatches, so the
// hydrated DOM would keep the server's stale values. The store instead
// renders the server snapshot ("inline") during hydration, then React
// re-renders once the client snapshot differs.
const citationModeListeners = new Set<() => void>();

function getStoredCitationMode(): CitationMode {
  if (typeof window === "undefined") return "inline";
  return window.localStorage.getItem(CITATION_MODE_STORAGE_KEY) === "side" ? "side" : "inline";
}

function subscribeCitationMode(listener: () => void): () => void {
  citationModeListeners.add(listener);
  return () => {
    citationModeListeners.delete(listener);
  };
}

function setStoredCitationMode(mode: CitationMode): void {
  window.localStorage.setItem(CITATION_MODE_STORAGE_KEY, mode);
  citationModeListeners.forEach((listener) => listener());
}

const EMPTY_MESSAGES: ChatMessage[] = [];

const newId = (): string => crypto.randomUUID();

/**
 * The chat surface (spec #23, variant B layout): sidebar of the caller's
 * sessions, lazy session creation on the first message, answers streaming
 * token by token through the normalized SSE contract, and — this slice —
 * resuming a session's history from RagFlow and deleting sessions (with a
 * confirm step).
 */
export function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Map<string, ChatMessage[]>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // How citations open (spec #47): inline at the marker by default, or in a
  // docked side panel; the choice is device-local (issue #49). The external
  // store renders "inline" on the server and picks up the stored value after
  // hydration (see the store above).
  const citationMode = useSyncExternalStore<CitationMode>(subscribeCitationMode, getStoredCitationMode, () => "inline");
  // The one open citation across the whole thread (see CitationFocus above).
  const [citationFocus, setCitationFocus] = useState<CitationFocus | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The key of the thread the in-flight completion writes into ("new" until
  // the lazy session event re-homes it under the created session id).
  const threadKeyRef = useRef<string>("new");
  // Mirrors `streaming` for effect guards: a ref, so a callback that runs
  // between renders (the URL-change effect) reads the CURRENT value, not a
  // stale closure. History must never be refetched while a stream is in
  // flight — the lazy-session URL pin would replace the streaming thread
  // with a mid-generation snapshot (issue #34).
  const streamingRef = useRef(false);
  // Monotonic id of the newest history fetch: rapid session clicks must not
  // let an older fetch's settle (or its loading-clear) clobber a newer one.
  const historyRequestRef = useRef(0);

  // Loads a session's history from the server into the thread. Always
  // refetches: after a follow-up the server is the source of truth.
  const loadHistory = useCallback(
    (sessionId: string): void => {
      const requestId = ++historyRequestRef.current;
      setHistoryLoading(true);
      setError(null);
      getSessionMessages(sessionId)
        .then(({ status, body }) => {
          if (requestId !== historyRequestRef.current) return; // superseded
          if (status === 401) {
            router.replace("/auth/sign-in");
            return;
          }
          if (status !== 200) {
            setError(body.error?.message ?? "Could not load this session.");
            return;
          }
          setThreads((prev) => {
            const next = new Map(prev);
            next.set(
              sessionId,
              body.items.map((m) => ({
                id: newId(),
                role: m.role,
                content: m.content,
                thinking: m.thinking,
                citations: m.references,
              })),
            );
            return next;
          });
        })
        .catch(() => {
          if (requestId === historyRequestRef.current) setError("Could not load this session.");
        })
        .finally(() => {
          if (requestId === historyRequestRef.current) setHistoryLoading(false);
        });
    },
    [router],
  );

  // Initial load: the session list, preselected from ?s=, with its history.
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
        // The lazy-creation `session` event re-pins the URL mid-stream; a
        // history refetch then would replace the streaming thread with a
        // snapshot taken before the answer was stored — the streamed answer
        // would flash and vanish (issue #34).
        if (match !== undefined && !streamingRef.current) loadHistory(match.id);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load chat sessions.");
      });
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, loadHistory]);

  // Escape closes the side panel (issue #49); inline mode has no Escape
  // interaction.
  useEffect(() => {
    if (citationMode !== "side" || citationFocus === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setCitationFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [citationMode, citationFocus]);

  const activeThread = useMemo(
    () => (activeId === null ? threads.get("new") ?? EMPTY_MESSAGES : threads.get(activeId) ?? EMPTY_MESSAGES),
    [threads, activeId],
  );

  // The side panel shows the focused marker's citation, resolved from the
  // active thread — a stale focus from a switched-away session resolves to
  // null, so the panel never lingers on content that is no longer on screen.
  const panelCitation = useMemo(() => {
    if (citationFocus === null) return null;
    const message = activeThread.find((m) => m.id === citationFocus.messageId);
    return message?.citations?.find((c) => c.n === citationFocus.n) ?? null;
  }, [activeThread, citationFocus]);

  // The thread auto-scrolls to the latest content as the answer streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [activeThread, streaming]);

  // Clicking a chip toggles that marker's card: the same marker closes it,
  // any other marker replaces it — one card at a time across the whole
  // thread, rendered inline at the marker (issue #48) or in the side panel
  // (issue #49) depending on the mode.
  const handleCite = useCallback((focus: CitationFocus): void => {
    setCitationFocus((cur) => (cur !== null && sameFocus(cur, focus) ? null : focus));
  }, []);

  // Switching modes closes any open card (spec #47). Re-selecting the active
  // option is a no-op, per radiogroup semantics — it must not close the card.
  const chooseCitationMode = useCallback(
    (next: CitationMode): void => {
      if (next === citationMode) return;
      setStoredCitationMode(next);
      setCitationFocus(null);
    },
    [citationMode],
  );

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
    setConfirmDeleteId(null);
    setError(null);
    router.replace("/chat", { scroll: false });
  }, [router, streaming]);

  const select = useCallback(
    (id: string): void => {
      if (streaming) return;
      setActiveId(id);
      setConfirmDeleteId(null);
      setError(null);
      router.replace(`/chat?s=${id}`, { scroll: false });
      loadHistory(id);
    },
    [router, streaming, loadHistory],
  );

  const removeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const result = await deleteChatSession(sessionId);
      if (result.status === 401) {
        router.replace("/auth/sign-in");
        return;
      }
      if (result.status !== 204) {
        setError(result.body.error?.message ?? "Could not delete the session.");
        setConfirmDeleteId(null);
        return;
      }
      setConfirmDeleteId(null);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setThreads((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      if (activeId === sessionId) {
        setActiveId(null);
        router.replace("/chat", { scroll: false });
      }
      refreshSessions();
    },
    [activeId, router, refreshSessions],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === "" || streaming) return;
      setStreaming(true);
      streamingRef.current = true;
      setError(null);
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
            setError(event.message);
          }
        });
      } catch {
        setError("Could not reach the agent. Try again.");
      } finally {
        patchAssistant((m) => ({ ...m, streaming: false }));
        setStreaming(false);
        streamingRef.current = false;
        refreshSessions();
      }
    },
    [activeId, router, refreshSessions, streaming],
  );

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <>
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
                {confirmDeleteId === s.id ? (
                  <div className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-destructive">
                      Delete this chat?
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 px-2 text-xs"
                      aria-label="Confirm delete"
                      onClick={() => void removeSession(s.id)}
                    >
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      aria-label="Cancel delete"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="group relative">
                    <button
                      type="button"
                      aria-current={s.id === activeId ? "true" : undefined}
                      onClick={() => select(s.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-lg py-2 pl-2.5 pr-8 text-left text-sm transition-colors",
                        s.id === activeId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">{relativeTime(s.updated_at)}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${s.title}`}
                      onClick={() => setConfirmDeleteId(s.id)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b px-6 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{activeSession?.title ?? "New chat"}</h1>
            {activeSession !== null && (
              <p className="text-xs text-muted-foreground">Updated {relativeTime(activeSession.updated_at)}</p>
            )}
          </div>
          <CitationModeToggle mode={citationMode} onChange={chooseCitationMode} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
            {historyLoading ? (
              <p className="pt-16 text-center text-sm text-muted-foreground">Loading this conversation…</p>
            ) : activeThread.length === 0 ? (
              <EmptyState />
            ) : (
              activeThread.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  mode={citationMode}
                  focused={citationFocus}
                  onCite={handleCite}
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </div>
        <div className="border-t px-6 py-3">
          <div className="mx-auto max-w-3xl">
            {error !== null && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {error}
              </p>
            )}
            {/* The composer is also disabled while history loads, so a send
                cannot race the history fetch replacing the thread. */}
            <Composer onSend={(text) => void send(text)} disabled={streaming || historyLoading} />
          </div>
        </div>
      </section>
      </div>
      {citationMode === "side" && citationFocus !== null && panelCitation !== null && (
        <CitationPanel
          citation={panelCitation}
          cardId={citationCardId(citationFocus.messageId, citationFocus.n, citationFocus.occ)}
          onClose={() => setCitationFocus(null)}
        />
      )}
    </>
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

function MessageBubble({
  message,
  mode,
  focused,
  onCite,
}: {
  message: ChatMessage;
  mode: CitationMode;
  /** The thread-wide open citation; only the marker it names is affected. */
  focused: CitationFocus | null;
  onCite: (focus: CitationFocus) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  // Clicking an [n] chip toggles that marker's card (the page owns the
  // toggle); the card renders inside AnswerWithCitations at the marker's
  // position in the answer flow in inline mode (issue #48), and in the
  // docked side panel in side panel mode (issue #49).
  const handleCite = (n: number, occ: number): void => onCite({ messageId: message.id, n, occ });

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <ThinkingPane thinking={message.thinking} streaming={message.streaming} />
        <div className="text-sm leading-relaxed">
          <AnswerWithCitations
            content={message.content}
            citations={message.citations}
            messageId={message.id}
            mode={mode}
            focused={focused}
            onCite={handleCite}
          />
          {message.streaming && message.content !== "" && (
            <span className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 bg-foreground/70 motion-safe:animate-pulse" aria-hidden />
          )}
        </div>
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

/**
 * react-markdown v10 passes `node` (the hast element) to every component
 * unconditionally (passNode is hardcoded on). Strip it so it can never
 * spread onto a DOM element (issue #39).
 */
const stripNode = <P extends { node?: unknown }>(props: P): Omit<P, "node"> => {
  const { node: _node, ...rest } = props;
  void _node;
  return rest;
};

/**
 * Renders the agent's answer as markdown (issue #39) — RagFlow's agent
 * answers in markdown (headings, bold, lists, rules), and the pre-fix
 * renderer showed the raw syntax as literal text. A bare [n] citation marker
 * has no link-reference definition, so CommonMark keeps it as literal text;
 * walkMarkers then turns those text nodes back into the clickable chips,
 * wherever they land (paragraph, list item, …). Unmatched markers are inert.
 *
 * The open citation's card is rendered by the walker as the NEXT SIBLING of
 * its marker (issue #48) — the card interrupts the answer at the marker's
 * position instead of sitting below the whole answer — but only in inline
 * mode; in side panel mode (issue #49) the page renders the same card in the
 * docked panel instead, so the answer flow never moves. The card is a block
 * element, so inside a phrase-only container like <p> the nesting is
 * technically invalid HTML; it is only ever created client-side after
 * hydration (the initial state is always collapsed), so there is no parser
 * correction or hydration mismatch, and React's dev-mode nesting warning is
 * a console-only noise.
 */
function AnswerWithCitations({
  content,
  citations,
  messageId,
  mode,
  focused,
  onCite,
}: {
  content: string;
  citations?: ChatCitation[];
  messageId: string;
  mode: CitationMode;
  focused: CitationFocus | null;
  onCite: (n: number, occ: number) => void;
}) {
  const byOrdinal = new Map((citations ?? []).map((c) => [c.n, c]));
  // Each rendered marker gets its position among same-ordinal markers, in
  // document order — the card is anchored to the exact clicked occurrence.
  // The walk is deterministic per render, so occurrences are stable.
  const occCounts = new Map<number, number>();
  const nextOcc = (n: number): number => {
    const next = (occCounts.get(n) ?? 0) + 1;
    occCounts.set(n, next);
    return next;
  };

  const chip = (n: number, key: string | number) => {
    const cite = byOrdinal.get(n);
    const occ = nextOcc(n);
    const open = cite !== undefined && focused !== null && sameFocus(focused, { messageId, n, occ });
    const cardId = citationCardId(messageId, n, occ);
    return (
      <Fragment key={key}>
        <button
          type="button"
          onClick={() => onCite(n, occ)}
          disabled={cite === undefined}
          aria-expanded={cite !== undefined ? open : undefined}
          aria-controls={open ? cardId : undefined}
          aria-label={
            cite !== undefined
              ? `Source ${n}: ${cite.document_name}${open ? ", expanded" : ", collapsed"}`
              : `Source ${n}`
          }
          className={cn(
            "mx-0.5 inline-flex h-4 min-w-4 -translate-y-1.5 items-center justify-center rounded-full px-1 align-baseline text-[10px] font-semibold tabular-nums transition-colors",
            cite === undefined
              ? "bg-muted text-muted-foreground"
              : open
                ? "bg-primary text-primary-foreground ring-2 ring-primary/25"
                : "bg-primary/15 text-primary hover:bg-primary hover:text-primary-foreground",
          )}
        >
          {n}
        </button>
        {open && cite !== undefined && mode === "inline" && <CitationCard id={cardId} citation={cite} />}
      </Fragment>
    );
  };

  // Splits [n] markers out of a parsed element's children — text nodes become
  // chips in place, without disturbing the elements around them (issue #39).
  // Applied to every text-capable markdown element below, so a marker lands as
  // a chip wherever the agent put it (paragraph, list item, heading, …).
  const walkMarkers = (node: ReactNode): ReactNode => {
    if (typeof node === "string") {
      const parts = node.split(/(\[\d+\])/g);
      if (parts.length === 1) return node;
      return parts.map((part, idx) => {
        const match = /^\[(\d+)\]$/.exec(part);
        return match === null ? part : chip(Number(match[1]), idx);
      });
    }
    if (Array.isArray(node)) return node.map(walkMarkers);
    if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
      return cloneElement(node, { children: walkMarkers(node.props.children) });
    }
    return node;
  };

  // Element styles for the rendered markdown, with children routed through
  // walkMarkers (react-markdown's children prop must stay a raw string, so
  // the walk happens on each component's PARSED children instead). Links are
  // the exception: a chip inside an anchor would be invalid DOM nesting, so
  // a marker in link text stays literal.
  const components: Components = {
    p: (props) => <p className="my-2 first:mt-0" {...stripNode(props)}>{walkMarkers(props.children)}</p>,
    h1: (props) => <h1 className="mb-2 mt-3 text-lg font-semibold" {...stripNode(props)}>{walkMarkers(props.children)}</h1>,
    h2: (props) => <h2 className="mb-2 mt-3 text-base font-semibold" {...stripNode(props)}>{walkMarkers(props.children)}</h2>,
    h3: (props) => <h3 className="mb-1.5 mt-3 text-sm font-semibold" {...stripNode(props)}>{walkMarkers(props.children)}</h3>,
    h4: (props) => <h4 className="mb-1.5 mt-3 text-sm font-medium" {...stripNode(props)}>{walkMarkers(props.children)}</h4>,
    h5: (props) => <h5 className="mb-1.5 mt-3 text-sm font-medium" {...stripNode(props)}>{walkMarkers(props.children)}</h5>,
    h6: (props) => <h6 className="mb-1.5 mt-3 text-sm font-medium" {...stripNode(props)}>{walkMarkers(props.children)}</h6>,
    ul: (props) => <ul className="my-2 list-disc space-y-1 pl-5" {...stripNode(props)}>{walkMarkers(props.children)}</ul>,
    ol: (props) => <ol className="my-2 list-decimal space-y-1 pl-5" {...stripNode(props)}>{walkMarkers(props.children)}</ol>,
    li: (props) => <li className="leading-relaxed" {...stripNode(props)}>{walkMarkers(props.children)}</li>,
    strong: (props) => <strong className="font-semibold" {...stripNode(props)}>{walkMarkers(props.children)}</strong>,
    em: (props) => <em className="italic" {...stripNode(props)}>{walkMarkers(props.children)}</em>,
    // No marker walk in links: a chip inside an anchor would be invalid DOM
    // nesting, so a marker in link text stays literal.
    a: (props) => (
      <a
        className="font-medium text-primary underline hover:underline-offset-2"
        target="_blank"
        rel="noreferrer"
        {...stripNode(props)}
      >
        {props.children}
      </a>
    ),
    del: (props) => <del {...stripNode(props)}>{walkMarkers(props.children)}</del>,
    s: (props) => <s {...stripNode(props)}>{walkMarkers(props.children)}</s>,
    u: (props) => <u {...stripNode(props)}>{walkMarkers(props.children)}</u>,
    sup: (props) => <sup {...stripNode(props)}>{walkMarkers(props.children)}</sup>,
    sub: (props) => <sub {...stripNode(props)}>{walkMarkers(props.children)}</sub>,
    code: (props) => <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]" {...stripNode(props)}>{walkMarkers(props.children)}</code>,
    pre: (props) => (
      <pre className="my-2 overflow-x-auto rounded-lg bg-muted/40 p-3 text-xs leading-relaxed" {...stripNode(props)}>
        {walkMarkers(props.children)}
      </pre>
    ),
    blockquote: (props) => (
      <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...stripNode(props)}>
        {walkMarkers(props.children)}
      </blockquote>
    ),
    hr: (props) => <hr className="my-3 border-muted" {...stripNode(props)} />,
    table: (props) => <table className="my-2 w-full text-sm" {...stripNode(props)}>{walkMarkers(props.children)}</table>,
    th: (props) => <th className="border-b px-2 py-1 text-left font-medium" {...stripNode(props)}>{walkMarkers(props.children)}</th>,
    td: (props) => <td className="border-b px-2 py-1" {...stripNode(props)}>{walkMarkers(props.children)}</td>,
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}

/**
 * One cited source — the card LEADS with the chunk passage and page, then
 * shows the document name; "Open full document" appears only for our docs.
 * Rendered in the answer flow at its marker's position (issue #48); `id`
 * wires the marker's aria-controls. `whitespace-normal` keeps the card
 * readable when the marker happens to land in a <pre> (white-space inherits).
 */
function CitationCard({ id, citation }: { id: string; citation: ChatCitation }) {
  return (
    <div
      id={id}
      className="my-2 whitespace-normal rounded-lg border border-primary/40 bg-primary/5 p-3 text-left"
    >
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

/**
 * The two-option citation mode control in the chat header (spec #47): a
 * segmented radiogroup — "Inline" (default) and "Side panel" — with the
 * chosen mode marked aria-checked. The choice is device-local.
 */
function CitationModeToggle({ mode, onChange }: { mode: CitationMode; onChange: (mode: CitationMode) => void }) {
  const radio = (value: CitationMode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => onChange(value)}
      className={cn(
        "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label="How cited sources open"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border bg-muted p-0.5"
    >
      {radio("inline", "Inline")}
      {radio("side", "Side panel")}
    </div>
  );
}

/**
 * The docked side panel (issue #49): a fixed right dock hosting the focused
 * marker's citation card — the answer text never moves. The X button and
 * Escape close it; `cardId` is the focused marker's card id, so the marker's
 * aria-controls stays valid across both modes.
 */
function CitationPanel({ citation, cardId, onClose }: { citation: ChatCitation; cardId: string; onClose: () => void }) {
  return (
    <aside
      aria-label={`Cited source ${citation.n}`}
      className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l bg-background shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <p className="text-sm font-semibold">Cited source {citation.n}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close source panel"
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <CitationCard id={cardId} citation={citation} />
      </div>
    </aside>
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
