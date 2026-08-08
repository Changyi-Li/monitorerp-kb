"use client"

// PROTOTYPE — Variant B: "List-first".
// Minimal top bar, documents as a content-first list of rows, detail in a
// centered dialog. The primary action is inline on every row — the list IS
// the workflow.

import { useState } from "react"
import Link from "next/link"
import { FileText, Search, Upload } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { DocDetailBody, DocMenu, DownloadButton, PrimaryActionButton, StatusBadge, StatusProgress, TypeIcon } from "./doc-actions"
import { STATUS_LABELS, STATUS_ORDER, currentUser, docs as allDocs, type Doc, type DocStatus, type Role } from "./mock-data"

type FilterValue = "all" | DocStatus

export function VariantB({ role, onAction }: { role: Role; onAction: (message: string) => void }) {
  const [filter, setFilter] = useState<FilterValue>("all")
  const [selected, setSelected] = useState<Doc | null>(null)

  const list = filter === "all" ? allDocs : allDocs.filter((d) => d.status === filter)
  const isOwner = (d: Doc) => d.ownerId === currentUser.id

  return (
    <div className="min-h-dvh">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link href="/prototype/dashboard" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <FileText className="size-4" />
            </span>
            <span className="text-sm font-medium">Doc Manager</span>
          </Link>
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search documents…" className="h-8 pl-8" />
          </div>
          <Button size="sm" onClick={() => onAction("Upload document")}>
            <Upload data-icon="inline-start" />
            Upload
          </Button>
          <Avatar className="hidden size-8 sm:flex">
            <AvatarFallback>LW</AvatarFallback>
          </Avatar>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-medium">Documents</h1>
          <p className="text-sm text-muted-foreground">
            {allDocs.length} documents · dataset{" "}
            <span className="font-mono text-xs">monitorerp-china-internal</span>
          </p>
        </div>

        <Tabs value={filter} onValueChange={(v) => v && setFilter(v as FilterValue)} className="mt-4">
          <TabsList variant="line">
            <TabsTrigger value="all">All</TabsTrigger>
            {STATUS_ORDER.map((s) => (
              <TabsTrigger key={s} value={s}>
                {STATUS_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="mt-4 flex flex-col">
          {list.length === 0 ? (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>No {filter === "all" ? "" : STATUS_LABELS[filter]} documents</EmptyTitle>
                <EmptyDescription>Documents you upload will appear in this list.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            list.map((d) => (
              <div
                key={d.id}
                className="group flex cursor-pointer items-center gap-3 border-b py-3 transition-colors hover:bg-muted/40"
                onClick={() => setSelected(d)}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <TypeIcon ext={d.ext} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    .{d.ext} · {d.size} · {d.ownerName} · {d.updatedAt}
                  </p>
                </div>
                <div className="hidden w-28 shrink-0 justify-end sm:flex">
                  <StatusBadge status={d.status} />
                </div>
                {d.status === "publishing" && (
                  <div className="hidden w-24 shrink-0 sm:block">
                    <StatusProgress doc={d} />
                  </div>
                )}
                <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <DownloadButton doc={d} onAction={onAction} />
                  <PrimaryActionButton doc={d} role={role} isOwner={isOwner(d)} onAction={onAction} />
                  <DocMenu doc={d} role={role} isOwner={isOwner(d)} onAction={onAction} />
                </div>
              </div>
            ))
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          PROTOTYPE — actions are mocked; the full flow is on the wayfinder map.
        </p>
      </main>

      {/* Detail dialog */}
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
