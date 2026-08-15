"use client";

// THROWAWAY PROTOTYPE — citation-expansion UX comparison (grilled 2026-08-14).
// "Four variants of the chat citation expansion, switchable via ?variant=, on
// the existing /chat route." Four structurally different ways to show a cited
// source when a [n] chip is clicked in a long answer:
//   A — inline accordion (card opens at the citation's position in the text)
//   B — docked sources drawer (fixed right panel, answer never moves)
//   C — anchored popover (card opens near the clicked number)
//   D — auto-scroll baseline (today's bottom card, scrolled into view)
// NOT production code: static mock data, no tests, no persistence. When a
// winner is chosen, fold it into chat-page.tsx properly and delete this file.

import { Plus, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// --- Mock data (realistic sample content, per the KB domain) ---------------

interface ProtoCitation {
  n: number;
  content: string;
  document_name: string;
  page: number | null;
}

const CITATIONS: ProtoCitation[] = [
  {
    n: 1,
    content:
      "Only a published document is parsed by RagFlow and becomes retrievable. Drafts are stored in the app only — they are never sent to the dataset, and the agent cannot see them.",
    document_name: "Publishing Guide",
    page: 3,
  },
  {
    n: 2,
    content:
      "The publishing state is transient. The sweeper reconciles RagFlow's run state on every poll interval and settles the document to published or failed once the parse completes, so a tab can be closed mid-parse without losing the outcome.",
    document_name: "Document Lifecycle",
    page: 12,
  },
  {
    n: 3,
    content:
      "A failed publish can be retried up to three times. Once retries are exhausted the document must be withdrawn to draft; withdrawing removes the file's chunks from the dataset, so the source stops being retrievable until it is re-published.",
    document_name: "Troubleshooting FAQ",
    page: 8,
  },
  {
    n: 4,
    content:
      "The dataset is a single server-side configuration (RAGFLOW_DATASET_ID) managed by a super admin. Documents have no dataset field of their own — there is no per-document dataset choice.",
    document_name: "RagFlow Dataset Setup",
    page: 5,
  },
];

/** Long mock answer — long enough that the answer alone overflows several
 *  viewport heights, so the "expansion lands out of view" problem is real. */
const ANSWER_PARAGRAPHS: string[] = [
  "Publishing a document moves it from draft into the RagFlow pipeline: the file is sent to the configured dataset, where it is parsed into chunks that the agent can then retrieve [1]. Until you publish, a draft stays private to you and is never sent anywhere.",
  "To publish, open the document's detail screen and press the Publish button. The document enters the publishing state immediately, and a server-side sweeper polls RagFlow until the parse settles [2]. Both the owner and any super admin may publish.",
  "Only a published document is parsed at all — a draft's file is never handed to RagFlow, and the agent can never see it [1]. This is the boundary between \"stored in the app\" and \"available to the agent\": nothing leaves your account until you explicitly publish.",
  "Parsing is asynchronous and can take anywhere from seconds to minutes depending on the file — a scanned PDF with a few hundred pages can run for several minutes [2]. The app shows the document as publishing while the parse runs.",
  "You can close the tab and come back later: the status is reconciled on every poll, so the outcome is never lost [2]. When the parse completes, the document settles to published and becomes retrievable by the agent; a short poll may show progress percentages before that.",
  "If the parse finishes without errors, the document is published and its chunks are indexed in the dataset. From that moment the agent can cite it in answers, and the citation chip links back to the source chunk [1].",
  "If parsing fails — an unreadable file, a parse timeout, or an upstream RagFlow error — the document moves to failed and the error is recorded on its history [3]. The history entry records who moved it, from which status to which, and when, together with your note.",
  "A failed publish can be retried up to three times; each retry resends the file to RagFlow [3]. Retries are useful for transient upstream problems — a RagFlow restart mid-parse, for example — but they never change the file itself.",
  "After the third failed attempt, retries are exhausted and the document must be withdrawn to draft before it can be published again [3]. This is the only way back to a publishable state once the retry budget is spent.",
  "Withdrawing a document removes its parsed chunks from the dataset, so the source stops being retrievable until it is re-published [3]. It is available to the owner for their own documents and to any super admin.",
  "The same withdraw action is also the way to take a published document out of retrieval on purpose — for example when the content is outdated and you want the agent to stop citing it while you prepare a new version [3].",
  "One caveat: a document is always published to the single configured dataset; there is no per-document dataset choice [4]. The dataset is configured server-side by a super admin, and the app never manages datasets.",
  "The dataset's display name is read from RagFlow at runtime, so the sidebar always shows the current name even if the configuration changes on the server [4]. The app itself never stores a dataset name of its own.",
  "If you need to update content, publish a new version of the document rather than editing the file in place — versioning is the supported way to keep a clean history of what changed when [1].",
  "Document history is the chronological record of every status transition — who moved it, from which status to which, when, and why [2]. It is shown on the document's detail screen and is the first place to look when something unexpected happened to a document.",
  "Access rules: any user can view and download any document, but only the owner edits, deletes, or changes its status [1]. Super admins may additionally delete any document, publish on anyone's behalf, and withdraw failed documents.",
  "Members manage their own documents; super admins additionally manage users — activation, role changes, and deactivation [2]. There is no account deletion in v1; deactivation is the removal mechanism, and the last active super admin can never be demoted or deactivated.",
  "If the agent's answer does not match what you expect, check the citation chips first: each chip opens the source passage it is based on, and the quoted content will show you exactly which chunk the answer was built from [1].",
  "In short: upload a draft, publish it, let it parse, and the agent can retrieve it. If parsing fails, retry up to three times; if it still fails, withdraw to draft and re-publish after fixing the file [3].",
];

const USER_QUESTION = "How do I publish a document, and what happens if parsing fails?";

const MOCK_SESSIONS = [
  { title: "How do I publish a document?", when: "2m ago", active: true },
  { title: "Withdraw after failed retries", when: "1h ago", active: false },
  { title: "Dataset configuration", when: "yesterday", active: false },
  { title: "Document versioning", when: "3d ago", active: false },
];

const byN = (n: number): ProtoCitation => {
  const found = CITATIONS.find((c) => c.n === n);
  if (found === undefined) throw new Error(`Missing mock citation ${n}`);
  return found;
};

type Token = { cite?: number; text?: string };

const tokensOf = (text: string): Token[] =>
  text
    .split(/(\[\d+\])/g)
    .filter(Boolean)
    .map((part) => {
      const match = /^\[(\d+)\]$/.exec(part);
      return match === null ? { text: part } : { cite: Number(match[1]) };
    });

// --- Shared pieces (same visual language as the real chat) -----------------

function Chip({
  n,
  active,
  onCite,
}: {
  n: number;
  active?: boolean;
  onCite: (n: number, anchor: HTMLElement) => void;
}) {
  const cite = CITATIONS.find((c) => c.n === n);
  return (
    <button
      type="button"
      onClick={(e) => onCite(n, e.currentTarget)}
      disabled={cite === undefined}
      aria-expanded={active}
      aria-label={cite !== undefined ? `Source ${n}: ${cite.document_name}` : `Source ${n}`}
      className={cn(
        "mx-0.5 inline-flex h-4 min-w-4 -translate-y-1.5 items-center justify-center rounded-full px-1 align-baseline text-[10px] font-semibold tabular-nums transition-colors",
        cite === undefined
          ? "bg-muted text-muted-foreground"
          : active
            ? "bg-primary text-primary-foreground"
            : "bg-primary/15 text-primary hover:bg-primary hover:text-primary-foreground",
      )}
    >
      {n}
    </button>
  );
}

/** Mirrors the real CitationCard visuals, minus the doc link (mock docs don't exist). */
function ProtoCitationCard({ citation, className }: { citation: ProtoCitation; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-primary/40 bg-primary/5 p-3 text-left", className)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary tabular-nums">
          {citation.n}
        </span>
        <p className="min-w-0 flex-1 border-l-2 pl-2 text-sm leading-relaxed text-muted-foreground">
          {citation.content}
        </p>
        {citation.page !== null && <span className="shrink-0 text-xs text-muted-foreground">page {citation.page}</span>}
      </div>
      <p className="mt-2 truncate text-sm font-medium" title={citation.document_name}>
        {citation.document_name}
      </p>
    </div>
  );
}

/** Plain paragraphs with inline chips — the shared answer body for B, C, D. */
const paragraphsWithChips = (onCite: (n: number) => void, isActive: (n: number) => boolean) =>
  ANSWER_PARAGRAPHS.map((paragraph, i) => (
    <p key={i} className="my-2 text-sm leading-relaxed first:mt-0">
      {tokensOf(paragraph).map((token, j) =>
        token.cite === undefined ? (
          <span key={j}>{token.text}</span>
        ) : (
          <Chip key={j} n={token.cite} active={isActive(token.cite)} onCite={onCite} />
        ),
      )}
    </p>
  ));

// --- Variant A: inline accordion — cards open at the citation, in the flow ----

function VariantA() {
  // Keyed by token position ("paragraph:token"), so the card opens exactly
  // where it was clicked — a second [1] in another paragraph stays closed.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div>
      {ANSWER_PARAGRAPHS.map((paragraph, i) => {
        const parts: ReactNode[] = [];
        tokensOf(paragraph).forEach((token, j) => {
          const key = `${i}:${j}`;
          if (token.cite === undefined) {
            parts.push(<span key={`t${j}`}>{token.text}</span>);
          } else {
            parts.push(<Chip key={`c${j}`} n={token.cite} active={open.has(key)} onCite={() => toggle(key)} />);
            if (open.has(key)) {
              parts.push(
                <ProtoCitationCard
                  key={`card${j}`}
                  citation={byN(token.cite)}
                  className="my-2 w-full"
                />,
              );
            }
          }
        });
        return (
          <div key={i} className="my-2 text-sm leading-relaxed first:mt-0">
            {parts}
          </div>
        );
      })}
    </div>
  );
}

// --- Variant B: docked sources drawer — fixed right panel, answer never moves -

function VariantB() {
  const [active, setActive] = useState<number | null>(null);
  const toggle = (n: number): void => setActive((cur) => (cur === n ? null : n));

  useEffect(() => {
    if (active === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const citation = active !== null ? byN(active) : null;
  return (
    <>
      {paragraphsWithChips(toggle, (n) => n === active)}
      {citation !== null && (
        <aside
          aria-label={`Cited source ${citation.n}`}
          className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <p className="text-sm font-semibold">Cited source {citation.n}</p>
            <button
              type="button"
              onClick={() => setActive(null)}
              aria-label="Close source panel"
              className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <ProtoCitationCard citation={citation} />
          </div>
        </aside>
      )}
    </>
  );
}

// --- Variant C: anchored popover — card opens at the clicked number ----------

const POPOVER_WIDTH = 384;
const POPOVER_MAX_HEIGHT = 320;

function VariantC() {
  // Fixed-position anchor computed from the clicked chip's rect: chips sit at
  // line ends, so a naive "below the chip" popover would run off the right
  // edge of the viewport; clamping keeps it visible on any chip.
  const [pos, setPos] = useState<{ n: number; x: number; y: number } | null>(null);

  const openAt = (n: number, anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    let x = rect.left;
    if (x + POPOVER_WIDTH > window.innerWidth - 16) x = Math.max(16, window.innerWidth - POPOVER_WIDTH - 16);
    let y = rect.bottom + 8;
    if (y + POPOVER_MAX_HEIGHT > window.innerHeight - 16) y = Math.max(16, rect.top - POPOVER_MAX_HEIGHT - 8);
    setPos((cur) => (cur?.n === n && cur.x === x && cur.y === y ? null : { n, x, y }));
  };

  // Close on click-outside or Escape while the popover is open.
  useEffect(() => {
    if (pos === null) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (target === null || !document.querySelector(`[data-citation-popover]`)?.contains(target)) {
        setPos(null);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPos(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  const citation = pos !== null ? byN(pos.n) : null;
  return (
    <div>
      {ANSWER_PARAGRAPHS.map((paragraph, i) => (
        <p key={i} className="my-2 text-sm leading-relaxed first:mt-0">
          {tokensOf(paragraph).map((token, j) =>
            token.cite === undefined ? (
              <span key={j}>{token.text}</span>
            ) : (
              <span key={j} className="inline">
                <Chip n={token.cite} active={pos?.n === token.cite} onCite={openAt} />
              </span>
            ),
          )}
        </p>
      ))}
      {citation !== null && pos !== null && (
        <div
          data-citation-popover
          style={{ left: pos.x, top: pos.y, width: POPOVER_WIDTH }}
          className="fixed z-30 max-h-80 overflow-y-auto rounded-lg shadow-xl"
        >
          <ProtoCitationCard citation={citation} />
        </div>
      )}
    </div>
  );
}

// --- Variant D: auto-scroll baseline — today's bottom card, scrolled into view

function VariantD() {
  const [active, setActive] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // The card mounts below the answer; bring it into view without moving the
  // user's place any more than necessary (this is the whole variant).
  useEffect(() => {
    if (active === null) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active]);

  const citation = active !== null ? byN(active) : null;
  return (
    <>
      {paragraphsWithChips((n) => setActive((cur) => (cur === n ? null : n)), (n) => n === active)}
      {citation !== null && (
        <div ref={cardRef} className="mt-3">
          <ProtoCitationCard citation={citation} />
        </div>
      )}
    </>
  );
}

// --- The prototype surface: mock thread inside the real chat frame -----------

export function CitationExpansionPrototype({ variant }: { variant: string }) {
  return (
    <div className="flex h-full min-h-0">
      {/* Static session sidebar — mock, mirrors the real chat page. */}
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar/40">
        <div className="p-3">
          <Button className="w-full justify-start" disabled>
            <Plus aria-hidden /> New chat
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <ul className="flex flex-col gap-0.5">
            {MOCK_SESSIONS.map((s) => (
              <li key={s.title}>
                <div
                  className={cn(
                    "flex cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2",
                    s.active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="truncate text-sm font-medium">{s.title}</span>
                  <span className="text-xs">{s.when}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-6 py-3">
          <h1 className="truncate text-sm font-semibold">Mock session — citation prototype</h1>
          <p className="text-xs text-muted-foreground">Static mock · flip variants with the bar below (or ← / →)</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {USER_QUESTION}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm leading-relaxed">
                  {variant === "A" && <VariantA />}
                  {variant === "B" && <VariantB />}
                  {variant === "C" && <VariantC />}
                  {variant === "D" && <VariantD />}
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              PROTOTYPE — mock answer and sources · the live chat is untouched
            </p>
          </div>
        </div>
        <div className="border-t px-6 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm" aria-hidden>
              <div className="flex-1 px-2 py-1.5 text-sm text-muted-foreground">Ask about the knowledge base…</div>
              <span className="inline-flex size-9 items-center justify-center rounded-md bg-primary/80 text-primary-foreground">
                <Send className="size-4" />
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
