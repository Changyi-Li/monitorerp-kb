"use client";

import { Download, History, X } from "lucide-react";
import { useEffect, useState } from "react";

import { StatusBadge } from "@/components/documents/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { getDocument, type DocumentDetail, type DocumentItem, type HistoryEntry } from "@/lib/documents";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function HistoryList({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-muted-foreground">No history yet</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {history.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">
              {entry.actor.name}
              {entry.from_status === null ? " uploaded" : ` moved ${entry.from_status} → ${entry.to_status}`}
            </span>
            <time className="shrink-0 text-xs text-muted-foreground">{formatDate(entry.created_at)}</time>
          </div>
          {entry.note !== null && <p className="text-xs text-muted-foreground">{entry.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export function DetailPanel({ document: initial, onCloseAction }: { document: DocumentItem; onCloseAction: () => void }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDocument(initial.id).then(({ status, body }) => {
      if (!cancelled && status === 200) setDetail(body);
    });
    return () => {
      cancelled = true;
    };
  }, [initial.id]);

  const document = detail?.document ?? initial;
  const history = detail?.history;

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l bg-background motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-300">
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="truncate text-base font-semibold" title={document.name}>
            {document.name}
          </h2>
          <StatusBadge status={document.status} progress={document.progress} />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onCloseAction} aria-label="Close details">
          <X aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col gap-4 overflow-y-auto p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Owner</dt>
            <dd className="font-medium">{document.owner.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Updated</dt>
            <dd>{formatDate(document.updated_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Size</dt>
            <dd>{formatBytes(document.size_bytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Chunk method</dt>
            <dd>{document.chunk_method}</dd>
          </div>
          {document.status === "published" && (
            <div>
              <dt className="text-xs text-muted-foreground">Chunks</dt>
              <dd>{document.chunk_count}</dd>
            </div>
          )}
          {document.status === "failed" && (
            <div>
              <dt className="text-xs text-muted-foreground">Retries left</dt>
              <dd>{document.retries_left}</dd>
            </div>
          )}
        </dl>

        <div className="flex flex-col gap-2">
          <a
            href={`/api/documents/${document.id}/download`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "inline-flex gap-1.5")}
          >
            <Download aria-hidden />
            Download
          </a>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="size-4 text-muted-foreground" aria-hidden />
            History
          </h3>
          {history === undefined ? <p className="text-sm text-muted-foreground">Loading…</p> : <HistoryList history={history} />}
        </section>
      </div>
    </aside>
  );
}
