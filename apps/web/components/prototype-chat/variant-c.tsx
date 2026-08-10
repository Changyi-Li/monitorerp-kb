"use client";

// PROTOTYPE variant C — "Citations rail": a slim session strip (sessions
// de-emphasised to icons) + thread + a persistent right rail showing the cited
// sources of the latest answer. Citation-primary hierarchy — the knowledge-base
// linkage is front-and-centre. Clicking an inline [n] chip highlights its card.

import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatApi, ChatCitation, ChatMessage } from "@/components/prototype-chat/shared";
import {
  CitationCard,
  Composer,
  MessageBubble,
  relativeTime,
  useChat,
} from "@/components/prototype-chat/shared";

const EMPTY_MESSAGES: ChatMessage[] = [];

export function VariantC() {
  const chat = useChat();
  const [highlight, setHighlight] = useState<number | null>(null);

  const railCitations = useMemo<ChatCitation[]>(() => {
    const msgs = chat.active?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.citations && m.citations.length > 0) return m.citations;
    }
    return [];
  }, [chat.active]);

  return (
    <div className="flex h-full min-h-0">
      <SessionStrip chat={chat} />
      <Thread chat={chat} onCite={setHighlight} />
      <SourcesRail citations={railCitations} highlight={highlight} />
    </div>
  );
}

function SessionStrip({ chat }: { chat: ChatApi }) {
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar/40 py-3">
      <Button size="icon" variant="default" aria-label="New chat" onClick={chat.startNew}>
        <Plus className="size-4" aria-hidden />
      </Button>
      <div className="my-1 h-px w-8 bg-border" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {chat.sessions.map((s) => (
          <div key={s.id} className="group relative">
            <button
              type="button"
              aria-label={s.title}
              aria-current={s.id === chat.activeId ? "true" : undefined}
              title={`${s.title} · ${relativeTime(s.updatedAt)}`}
              onClick={() => chat.select(s.id)}
              className={cn(
                "flex size-9 items-center justify-center rounded-lg text-sm font-semibold transition-colors",
                s.id === chat.activeId
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              {s.title.trim().charAt(0).toUpperCase() || "?"}
            </button>
            <button
              type="button"
              aria-label={`Delete ${s.title}`}
              onClick={() => chat.remove(s.id)}
              className="absolute -right-0.5 -top-0.5 hidden size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
            >
              <Trash2 className="size-2.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Thread({ chat, onCite }: { chat: ChatApi; onCite: (ordinal: number) => void }) {
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
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-5" aria-hidden />
              </div>
              <h2 className="text-base font-semibold">Ask about the knowledge base</h2>
              <p className="max-w-sm text-sm text-muted-foreground">Cited sources stay visible in the rail on the right.</p>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} onCite={onCite} />)
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t px-6 py-3">
        <div className="mx-auto max-w-2xl">
          <Composer onSend={chat.send} disabled={chat.streamingId !== null} />
        </div>
      </div>
    </section>
  );
}

function SourcesRail({ citations, highlight }: { citations: ChatCitation[]; highlight: number | null }) {
  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l lg:flex">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Sources</h2>
        <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{citations.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {citations.length === 0 ? (
          <p className="px-1 py-6 text-sm text-muted-foreground">
            Sources from the latest answer appear here and link back to the documents this app manages.
          </p>
        ) : (
          <div className="space-y-2">
            {citations.map((c) => (
              <CitationCard key={c.ordinal} citation={c} highlighted={highlight === c.ordinal} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
