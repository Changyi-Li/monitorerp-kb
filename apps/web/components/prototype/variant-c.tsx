"use client"

// PROTOTYPE — Variant C: "Status pipeline".
// Kanban-style columns per document status — the lifecycle is the layout.
// Drag-and-drop is NOT implemented (prototype); actions move cards in the
// real app.

import { useState } from "react"
import Link from "next/link"
import { Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

import { DocDetailBody, DocMenu, PrimaryActionButton, StatusProgress, TypeIcon } from "./doc-actions"
import { STATUS_LABELS, STATUS_ORDER, currentUser, docs as allDocs, type Doc, type Role } from "./mock-data"

const DOT: Record<string, string> = {
  draft: "bg-muted-foreground/30",
  ready: "bg-primary/60",
  publishing: "bg-primary",
  published: "bg-foreground",
  failed: "bg-destructive",
}

export function VariantC({ role, onAction }: { role: Role; onAction: (message: string) => void }) {
  const [selected, setSelected] = useState<Doc | null>(null)
  const isOwner = (d: Doc) => d.ownerId === currentUser.id

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-medium">Documents</h1>
          <Badge variant="secondary">{allDocs.length}</Badge>
          <Link
            href="/prototype/dashboard/users"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Users
          </Link>
        </div>
        <Button size="sm" onClick={() => onAction("Upload document")}>
          <Upload data-icon="inline-start" />
          Upload
        </Button>
      </header>

      <main className="flex gap-4 overflow-x-auto px-6 pt-5 pb-8">
        {STATUS_ORDER.map((s) => {
          const list = allDocs.filter((d) => d.status === s)
          return (
            <section key={s} className="flex w-64 shrink-0 flex-col rounded-xl bg-muted/50 p-2">
              <header className="flex items-center justify-between px-1.5 pb-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span className={`size-2 rounded-full ${DOT[s]}`} />
                  {STATUS_LABELS[s]}
                  <span className="text-xs text-muted-foreground">{list.length}</span>
                </span>
              </header>
              <div className="flex flex-col gap-2">
                {list.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-2 py-4 text-center text-xs text-muted-foreground">
                    Nothing here yet
                  </p>
                ) : (
                  list.map((d) => (
                    <Card
                      key={d.id}
                      size="sm"
                      className="cursor-pointer gap-2"
                      onClick={() => setSelected(d)}
                    >
                      <CardContent className="flex flex-col gap-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted">
                              <TypeIcon ext={d.ext} />
                            </span>
                            <p className="truncate text-sm font-medium">{d.name}</p>
                          </div>
                          <div onClick={(e) => e.stopPropagation()}>
                            <DocMenu doc={d} role={role} isOwner={isOwner(d)} onAction={onAction} />
                          </div>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          .{d.ext} · {d.size} · {d.ownerName}
                        </p>
                        {d.status === "publishing" && <StatusProgress doc={d} />}
                        {d.status === "failed" && (
                          <p className="text-xs text-destructive">{d.retriesLeft} retries left</p>
                        )}
                        <div onClick={(e) => e.stopPropagation()}>
                          <PrimaryActionButton
                            doc={d}
                            role={role}
                            isOwner={isOwner(d)}
                            onAction={onAction}
                            size="xs"
                          />
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </section>
          )
        })}
      </main>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="sr-only">Document details</DialogTitle>
          <DialogDescription className="sr-only">
            Details and actions for the selected document
          </DialogDescription>
          {selected && (
            <DocDetailBody doc={selected} role={role} isOwner={isOwner(selected)} onAction={onAction} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
