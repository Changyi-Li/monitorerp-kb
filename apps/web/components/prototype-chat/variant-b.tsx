"use client";

// PROTOTYPE variant B — "Thread-first": no persistent session list. History
// lives behind a "History" button that opens a slide-over drawer, so the thread
// gets the full width. Thread-primary hierarchy.

import { History, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatApi, ChatMessage } from "@/components/prototype-chat/shared";
import { Composer, MessageBubble, relativeTime, useChat } from "@/components/prototype-chat/shared";

const EMPTY_MESSAGES: ChatMessage[] = [];

export function VariantB() {
  const chat = useChat();
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History aria-hidden /> History
          <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {chat.sessions.length}
          </span>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold">{chat.active?.title ?? "New chat"}</h1>
        <Button variant="ghost" size="sm" onClick={chat.startNew}>
          <Plus aria-hidden /> New
        </Button>
      </header>

      <Thread chat={chat} />

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} chat={chat} />
    </div>
  );
}

function Thread({ chat }: { chat: ChatApi }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => chat.active?.messages ?? EMPTY_MESSAGES, [chat.active]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, chat.streamingId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-20 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-5" aria-hidden />
              </div>
              <h2 className="text-base font-semibold">Ask about the knowledge base</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                History is one click away — the thread gets the whole width.
              </p>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} onCite={() => {}} />)
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <Composer onSend={chat.send} disabled={chat.streamingId !== null} />
        </div>
      </div>
    </section>
  );
}

function HistoryDrawer({ open, onClose, chat }: { open: boolean; onClose: () => void; chat: ChatApi }) {
  return (
    <div className={cn("absolute inset-0 z-20", open ? "pointer-events-auto" : "pointer-events-none")} aria-hidden={!open}>
      <div
        className={cn("absolute inset-0 bg-foreground/20 backdrop-blur-[1px] transition-opacity", open ? "opacity-100" : "opacity-0")}
        onClick={onClose}
      />
      <aside
        className={cn(
          "absolute left-0 top-0 flex h-full w-80 max-w-[85%] flex-col border-r bg-background shadow-xl transition-transform",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">History</h2>
          <Button variant="ghost" size="icon" aria-label="Close history" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="p-3">
          <Button variant="outline" className="w-full justify-start" onClick={() => { chat.startNew(); onClose(); }}>
            <Plus aria-hidden /> New chat
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {chat.sessions.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">No chats yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {chat.sessions.map((s) => (
                <li key={s.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-current={s.id === chat.activeId ? "true" : undefined}
                    onClick={() => {
                      chat.select(s.id);
                      onClose();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        chat.select(s.id);
                        onClose();
                      }
                    }}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      s.id === chat.activeId ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.title}</p>
                      <p className="text-xs text-muted-foreground">{relativeTime(s.updatedAt)}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Delete ${s.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        chat.remove(s.id);
                      }}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
