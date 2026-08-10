"use client";

// PROTOTYPE — throwaway. Three variants of the RagFlow-agent chatbot UI live in
// variant-{a,b,c}.tsx; this file holds the state model, the mock data, and the
// reusable leaf components every variant renders. The mock stream mimics the
// *normalized* event stream the real Hono proxy will emit (thinking → answer →
// references), not RagFlow's raw wire format, since the proxy normalizes both
// the inline <think> tags and the two citation shapes (research #20).

import { ChevronDown, ExternalLink, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — mirror the normalized shape the proxy will hand the client.
// ---------------------------------------------------------------------------

export interface ChatCitation {
  ordinal: number; // the [n] marker in the answer
  documentId: string; // RagFlow document_id (stable)
  documentName: string;
  page: number;
  chunk: string; // the cited passage — the actual reference, shown inline
  ourDocumentId: string | null; // our documents.id when this is one of ours, else null
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string; // answer text, no <think>
  thinking?: string; // parsed reasoning, hidden by default
  citations?: ChatCitation[];
  streaming?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string; // ISO
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = () => Date.now();

const CITE_OURS: ChatCitation = {
  ordinal: 1,
  documentId: "d9f2_purchase_arrivals",
  documentName: "zh-cn_Purchase_Arrivals_wReportArrival.md",
  page: 1,
  chunk:
    "Submit the Purchase Arrivals form within two business days of goods receipt. Include the PO number and supplier name.",
  ourDocumentId: "00000000-0000-0000-0000-000000000001",
};

const CITE_EXTERNAL: ChatCitation = {
  ordinal: 2,
  documentId: "x_supplier_late_policy",
  documentName: "Supplier Late-Submission Policy.pdf",
  page: 3,
  chunk: "Late submissions require written supervisor approval and a reason code.",
  ourDocumentId: null, // not one of our Documents → no deep link
};

const CITE_OURS_2: ChatCitation = {
  ordinal: 1,
  documentId: "b3_inventory_recon",
  documentName: "Inventory_Reconciliation_Procedure.md",
  page: 4,
  chunk: "Run the end-of-day reconciliation: compare system stock to counted stock, post adjustments.",
  ourDocumentId: "00000000-0000-0000-0000-000000000002",
};

const SEED_SESSIONS: ChatSession[] = [
  {
    id: "s1",
    title: "Reporting & reconciling purchase arrivals",
    updatedAt: new Date(now() - 2 * HOUR).toISOString(),
    messages: [
      { id: "s1m1", role: "user", content: "How do I report a purchase arrival?" },
      {
        id: "s1m2",
        role: "assistant",
        thinking:
          "The user is asking about reporting purchase arrivals. The Purchase Arrivals doc says submit within 48h of receipt; the Supplier Policy covers late submissions. I'll cite both.",
        content:
          "Purchase arrivals are reported via the Purchase Arrivals form [1], submitted within 48 hours of goods receipt. Late submissions require written supervisor approval [2].",
        citations: [{ ...CITE_OURS, ordinal: 1 }, { ...CITE_EXTERNAL, ordinal: 2 }],
      },
      { id: "s1m3", role: "user", content: "What counts as goods receipt — the delivery date, or when we inspect it?" },
      {
        id: "s1m4",
        role: "assistant",
        thinking: "Receipt vs inspection: receipt is physical arrival plus sign-off. The 48-hour clock starts at receipt, not inspection.",
        content:
          "Goods receipt is when the shipment physically arrives at your warehouse and is signed for — not the inspection date. Inspection can happen afterward, but the 48-hour clock starts at receipt.",
      },
      { id: "s1m5", role: "user", content: "What happens if I miss the 48-hour window?" },
      {
        id: "s1m6",
        role: "assistant",
        thinking: "Late submission policy: supervisor approval plus a reason code. Cite the supplier policy.",
        content:
          "Late submissions require written supervisor approval and a reason code before the form is accepted [1]. Repeated late filings may flag the supplier for review.",
        citations: [{ ...CITE_EXTERNAL, ordinal: 1 }],
      },
      { id: "s1m7", role: "user", content: "Can I batch several arrivals into one form?" },
      {
        id: "s1m8",
        role: "assistant",
        thinking: "Batching: each arrival is its own form, for traceability to the PO and supplier. No batching.",
        content:
          "No — each purchase arrival needs its own form so each can be traced to its PO and supplier. If you have several, submit them back-to-back; the system queues them.",
      },
      { id: "s1m9", role: "user", content: "Once submitted, where does the data go?" },
      {
        id: "s1m10",
        role: "assistant",
        thinking: "Data flow: arrivals register updates stock on hand, which feeds the end-of-day reconciliation. Cite the arrivals doc.",
        content: "The form posts the arrival to the arrivals register, which updates stock on hand and feeds the end-of-day reconciliation [1].",
        citations: [{ ...CITE_OURS, ordinal: 1 }],
      },
      { id: "s1m11", role: "user", content: "And reconciliation compares that against what?" },
      {
        id: "s1m12",
        role: "assistant",
        thinking: "Reconciliation compares system stock to the floor's counted stock, then posts adjustments. Cite the recon procedure.",
        content:
          "Reconciliation compares the system stock (updated by these arrivals) against the counted stock from the floor, then posts any adjustments [1].",
        citations: [{ ...CITE_OURS_2, ordinal: 1 }],
      },
    ],
  },
  {
    id: "s2",
    title: "Inventory reconciliation steps",
    updatedAt: new Date(now() - DAY).toISOString(),
    messages: [
      { id: "s2m1", role: "user", content: "What are the inventory reconciliation steps?" },
      {
        id: "s2m2",
        role: "assistant",
        thinking: "Inventory reconciliation is documented in the procedure guide — cite it.",
        content: "Run the end-of-day reconciliation: compare system stock to counted stock, then post adjustments [1].",
        citations: [CITE_OURS_2],
      },
    ],
  },
  {
    id: "s3",
    title: "How do I deactivate a user?",
    updatedAt: new Date(now() - 6 * DAY).toISOString(),
    messages: [
      { id: "s3m1", role: "user", content: "How do I deactivate a user?" },
      {
        id: "s3m3",
        role: "assistant",
        thinking: "Only super admins can deactivate. The last active super admin can never be deactivated.",
        content:
          "Only a super admin can deactivate a user. Open Users, choose the person, and select Deactivate. The last active super admin can never be deactivated.",
      },
    ],
  },
];

// The scripted reply streamed for any new message in the prototype.
const DEMO_REPLY = {
  thinking:
    "The user is asking about reporting purchase arrivals. The Purchase Arrivals doc says submit within 48h of receipt; the Supplier Policy covers late submissions. I'll cite both.",
  answer:
    "Purchase arrivals are reported via the Purchase Arrivals form [1], submitted within 48 hours of goods receipt. Late submissions require written supervisor approval [2].",
  citations: [CITE_OURS, CITE_EXTERNAL],
};

export const PROTOTYPE_VARIANTS = [
  { key: "A", name: "With Sources list" },
  { key: "B", name: "No Sources list" },
] as const;

export type VariantKey = (typeof PROTOTYPE_VARIANTS)[number]["key"];

// ---------------------------------------------------------------------------
// Streaming driver — mimics the proxy's normalized events.
// ---------------------------------------------------------------------------

export interface StreamCallbacks {
  onThinkingDelta: (delta: string) => void;
  onAnswerDelta: (delta: string) => void;
  onCitations: (citations: ChatCitation[]) => void;
  onDone: () => void;
}

const splitTokens = (text: string): string[] => text.split(/(\s+)/);

/** Streams the demo reply token-by-token. Returns a cancel function. */
export function streamMockReply(cb: StreamCallbacks): () => void {
  const thinking = splitTokens(DEMO_REPLY.thinking);
  const answer = splitTokens(DEMO_REPLY.answer);
  let phase: "thinking" | "answer" = "thinking";
  let i = 0;
  let timer: ReturnType<typeof setTimeout>;

  const take = (tokens: string[]): string => {
    // 1–3 tokens per tick for a natural cadence.
    const n = 1 + Math.floor(Math.random() * 3);
    const slice = tokens.slice(i, i + n).join("");
    i += n;
    return slice;
  };

  const step = (): void => {
    if (phase === "thinking") {
      if (i < thinking.length) {
        cb.onThinkingDelta(take(thinking));
        timer = setTimeout(step, 22 + Math.random() * 20);
      } else {
        phase = "answer";
        i = 0;
        timer = setTimeout(step, 160); // brief beat between reasoning and answer
      }
    } else if (i < answer.length) {
      cb.onAnswerDelta(take(answer));
      timer = setTimeout(step, 26 + Math.random() * 24);
    } else {
      cb.onCitations(DEMO_REPLY.citations);
      cb.onDone();
    }
  };

  timer = setTimeout(step, 280); // initial "thinking…" delay
  return () => clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// useChat — the shared state model every variant renders.
// ---------------------------------------------------------------------------

const cloneSeed = (): ChatSession[] =>
  structuredClone(SEED_SESSIONS).map((s) => ({ ...s, updatedAt: s.updatedAt }));

const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const titleFrom = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || "New chat";
};

export interface ChatApi {
  sessions: ChatSession[];
  activeId: string | null;
  active: ChatSession | null;
  streamingId: string | null;
  select: (id: string) => void;
  startNew: () => void;
  remove: (id: string) => void;
  send: (text: string) => void;
}

export function useChat(): ChatApi {
  const [sessions, setSessions] = useState<ChatSession[]>(cloneSeed);
  const [activeId, setActiveId] = useState<string | null>(SEED_SESSIONS[0]!.id);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, updatedAt: new Date().toISOString(), messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)) }
            : s,
        ),
      );
    },
    [],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || activeId === null) return;

      const sessionId = activeId;
      const userMsg: ChatMessage = { id: newId("m"), role: "user", content: trimmed };
      const assistantId = newId("a");
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", thinking: "", streaming: true };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const isFirst = s.messages.length === 0 || (s.messages.length === 1 && s.title === "New chat");
          return {
            ...s,
            title: isFirst ? titleFrom(trimmed) : s.title,
            updatedAt: new Date().toISOString(),
            messages: [...s.messages, userMsg, assistantMsg],
          };
        }),
      );
      setStreamingId(assistantId);

      cancelRef.current?.();
      cancelRef.current = streamMockReply({
        onThinkingDelta: (d) => patchMessage(sessionId, assistantId, (m) => ({ ...m, thinking: (m.thinking ?? "") + d })),
        onAnswerDelta: (d) => patchMessage(sessionId, assistantId, (m) => ({ ...m, content: m.content + d })),
        onCitations: (c) => patchMessage(sessionId, assistantId, (m) => ({ ...m, citations: c })),
        onDone: () => {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, streaming: false }));
          setStreamingId(null);
          cancelRef.current = null;
        },
      });
    },
    [activeId, patchMessage],
  );

  const startNew = useCallback(() => {
    const id = newId("s");
    const session: ChatSession = { id, title: "New chat", updatedAt: new Date().toISOString(), messages: [] };
    setSessions((prev) => [session, ...prev]);
    setActiveId(id);
  }, []);

  const remove = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current));
        return next;
      });
    },
    [],
  );

  const select = useCallback((id: string) => setActiveId(id), []);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return { sessions, activeId, active, streamingId, select, startNew, remove, send };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / MIN);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Leaf components — reused by every variant.
// ---------------------------------------------------------------------------

/** Renders inline [n] markers in an answer as clickable superscript chips. */
function AnswerWithCitations({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations?: ChatCitation[];
  onCite: (ordinal: number) => void;
}) {
  const byOrdinal = new Map((citations ?? []).map((c) => [c.ordinal, c]));
  const parts = content.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, idx) => {
        const m = /^\[(\d+)\]$/.exec(part);
        if (m === null) return <span key={idx}>{part}</span>;
        const n = Number(m[1]);
        const cite = byOrdinal.get(n);
        return (
          <button
            key={idx}
            type="button"
            onClick={() => cite !== undefined && onCite(n)}
            disabled={cite === undefined}
            aria-label={cite ? `Source ${n}: ${cite.documentName}` : `Source ${n}`}
            className={cn(
              "mx-0.5 inline-flex h-4 min-w-4 -translate-y-1.5 items-center justify-center rounded-full px-1 align-baseline text-[10px] font-semibold tabular-nums transition-colors",
              cite
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

/** Collapsible reasoning pane — collapsed by default; "Show thinking" reveals it. */
export function ThinkingPane({
  thinking,
  streaming,
  highlighted,
}: {
  thinking?: string;
  streaming?: boolean;
  highlighted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const empty = (thinking ?? "") === "" && !streaming;
  if (empty) return null;

  return (
    <div className={cn("mb-2 overflow-hidden rounded-lg border", highlighted ? "border-primary/30 bg-primary/5" : "bg-muted/40")}>
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

/** One cited source — chunk passage leads; "Open full document" only for our docs. */
export function CitationCard({ citation, highlighted }: { citation: ChatCitation; highlighted?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        highlighted ? "border-primary/40 bg-primary/5" : "bg-card",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary tabular-nums">
          {citation.ordinal}
        </span>
        <span className="truncate text-sm font-medium" title={citation.documentName}>
          {citation.documentName}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">page {citation.page}</span>
      </div>
      <p className="mt-2 border-l-2 pl-2 text-sm leading-relaxed text-muted-foreground">{citation.chunk}</p>
      {citation.ourDocumentId !== null && (
        <Link
          href="/"
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

export function SourcesPanel({ citations, highlight }: { citations?: ChatCitation[]; highlight?: number }) {
  const [open, setOpen] = useState(false);
  if (citations === undefined || citations.length === 0) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open ? "" : "-rotate-90")} aria-hidden />
        Sources
        <span className="rounded-full bg-muted px-1.5 tracking-normal text-muted-foreground tabular-nums normal-case">
          {citations.length}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {citations.map((c) => (
            <CitationCard key={c.ordinal} citation={c} highlighted={highlight === c.ordinal} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single message row. */
export function MessageBubble({
  message,
  onCite,
  showSources = true,
}: {
  message: ChatMessage;
  onCite: (ordinal: number) => void;
  showSources?: boolean;
}) {
  // Clicking an inline [n] chip toggles a collapsible peek of that one source
  // directly under the answer. The Sources list below is optional (variant A
  // shows it; variant B hides it and relies on the chip-click peek alone).
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

  const handleCite = (n: number) => {
    setFocused((cur) => (cur === n ? null : n));
    onCite(n);
  };
  const focusedCitation = message.citations?.find((c) => c.ordinal === focused);

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
            <CitationCard citation={focusedCitation} highlighted />
          </div>
        )}

        {showSources && <SourcesPanel citations={message.citations} highlight={focused ?? undefined} />}
      </div>
    </div>
  );
}

/** Composer — Enter sends, Shift+Enter adds a newline. */
export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const submit = () => {
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
        className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Button size="icon" onClick={submit} disabled={disabled || text.trim() === ""} aria-label="Send message">
        <Send className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
