"use client";

import { MoreHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { DocumentActionOption } from "@/lib/documents";
import { cn } from "@/lib/utils";

/** The row "⋯" menu with the document's per-status/per-role actions. */
export function RowMenu({
  actions,
  busy,
  onAction,
}: {
  actions: DocumentActionOption[];
  busy: boolean;
  onAction: (option: DocumentActionOption) => void;
}) {
  const [open, setOpen] = useState(false);

  if (actions.length === 0) return null;

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Document actions"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal aria-hidden />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 z-50 flex min-w-40 flex-col rounded-lg border bg-popover p-1 shadow-md motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
          >
            {actions.map((option) => (
              <button
                key={option.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onAction(option);
                }}
                className={cn(
                  "flex items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                  option.destructive === true && "text-destructive hover:bg-destructive/10 hover:text-destructive",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
