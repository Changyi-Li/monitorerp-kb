"use client";

import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { ChatApi, ChatMessage } from "@/components/prototype-chat/shared";
import { Composer, MessageBubble, relativeTime, useChat } from "@/components/prototype-chat/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EMPTY_MESSAGES: ChatMessage[] = [];

// The two-pane layout variants A and B share. `showSources` is the only
// difference: A renders the collapsible Sources list under each answer; B omits
// it, so citations are reachable only via the inline [n] chip-click peek.
export function TwoPaneChat({ showSources }: { showSources: boolean }) {
  const chat = useChat();
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar/40">
        <div className="p-3">
          <Button className="w-full justify-start" onClick={chat.startNew}>
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
                    onClick={() => chat.select(s.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && chat.select(s.id)}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      s.id === chat.activeId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
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
      <Thread chat={chat} showSources={showSources} />
    </div>
  );
}

function Thread({ chat, showSources }: { chat: ChatApi; showSources: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => chat.active?.messages ?? EMPTY_MESSAGES, [chat.active]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, chat.streamingId]);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="truncate text-sm font-semibold">{chat.active?.title ?? "New chat"}</h1>
        {chat.active && <p className="text-xs text-muted-foreground">Updated {relativeTime(chat.active.updatedAt)}</p>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          {messages.length === 0 ? (
            <EmptyState showSources={showSources} />
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} onCite={() => {}} showSources={showSources} />)
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t px-6 py-3">
        <div className="mx-auto max-w-3xl">
          <Composer onSend={chat.send} disabled={chat.streamingId !== null} />
        </div>
      </div>
    </section>
  );
}

function EmptyState({ showSources }: { showSources: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 pt-16 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-5" aria-hidden />
      </div>
      <h2 className="text-base font-semibold">Ask about the knowledge base</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {showSources
          ? "Answers stream in with their reasoning hidden; cited sources link back to the documents this app manages."
          : "Answers stream in with their reasoning hidden. Click a citation marker to see its source."}
      </p>
    </div>
  );
}
