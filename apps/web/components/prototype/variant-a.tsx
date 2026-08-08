"use client"

// PROTOTYPE — Variant A: "Sidebar console" (winner), at five fanciness levels:
//   1 Baseline — as approved
//   2 Polished — status dots, blue-tinted active nav
//   3 Premium  — KPI strip, gradient logo, soft shadows
//   4 Rich     — staggered row entrance, shimmer on parse progress,
//                gradient accent on the detail panel, button glow
//   5 Showcase — ambient mesh background, glass sidebar & header, button shine
// The users page uses the same shell (see app-shell-a).

import { useState } from "react"
import { FileText, Loader2, Search, Upload, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

import { AppShellA } from "./app-shell-a"
import { DocDetailBody, DocMenu, DownloadButton, StatusBadge, StatusProgress, TypeIcon } from "./doc-actions"
import type { FancyLevel } from "./fancy"
import { STATUS_LABELS, STATUS_ORDER, currentUser, docs as allDocs, type Doc, type DocStatus, type Role } from "./mock-data"

type FilterValue = "all" | DocStatus

function KpiStrip({ fancy }: { fancy: FancyLevel }) {
  const total = allDocs.length
  const published = allDocs.filter((d) => d.status === "published").length
  const publishing = allDocs.filter((d) => d.status === "publishing").length
  const failed = allDocs.filter((d) => d.status === "failed").length
  const items = [
    { label: "Documents", value: total, icon: FileText, tone: "text-foreground", tile: fancy >= 5 ? "bg-primary/15 text-primary" : "bg-muted" },
    { label: "Published", value: published, icon: FileText, tone: "text-foreground", tile: fancy >= 5 ? "bg-primary/15 text-primary" : "bg-muted" },
    { label: "Parsing", value: publishing, icon: Loader2, tone: "text-primary", tile: fancy >= 5 ? "bg-primary/15 text-primary" : "bg-muted" },
    { label: "Failed", value: failed, icon: X, tone: "text-destructive", tile: fancy >= 5 ? "bg-destructive/10 text-destructive" : "bg-muted" },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label} size="sm" className={cn("gap-1", fancy >= 4 && "transition-shadow hover:shadow-md")}>
          <CardContent className="flex items-center gap-3">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", it.tile)}>
              <it.icon className="size-4" />
            </span>
            <div>
              <p className="text-2xl leading-none font-semibold tabular-nums">{it.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{it.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function VariantA({
  fancy,
  role,
  onAction,
}: {
  fancy: FancyLevel
  role: Role
  onAction: (message: string) => void
}) {
  const [status, setStatus] = useState<FilterValue>("all")
  const [ownerId, setOwnerId] = useState("all")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Doc | null>(null)

  const owners = Array.from(new Map(allDocs.map((d) => [d.ownerId, d.ownerName])).entries())

  const list = allDocs.filter((d) => {
    if (status !== "all" && d.status !== status) return false
    if (ownerId !== "all" && d.ownerId !== ownerId) return false
    if (query && !d.name.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const filtersActive = status !== "all" || ownerId !== "all" || query !== ""
  const clearFilters = () => {
    setStatus("all")
    setOwnerId("all")
    setQuery("")
  }
  const isOwner = (d: Doc) => d.ownerId === currentUser.id

  const headerGlass = fancy >= 5 ? "bg-background/70 backdrop-blur-md" : ""
  const tableShadow = fancy >= 3 ? "shadow-lg shadow-primary/5" : ""
  const stagger = fancy >= 4

  return (
    <AppShellA active="documents" role={role} fancy={fancy}>
      <header className={cn("flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3 transition-colors", headerGlass)}>
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">Documents</h1>
          <Badge variant="secondary">
            {list.length} of {allDocs.length}
          </Badge>
        </div>
        <Button size="sm" onClick={() => onAction("Upload document")}>
          <Upload data-icon="inline-start" />
          Upload
        </Button>
      </header>

      <div className="flex min-w-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col gap-4 p-6">
          {/* KPI strip — part of the final design (was F3's, promoted to F1). */}
          <KpiStrip fancy={fancy} />

          {/* Filter bar: status tabs + name search + owner select on one line */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={status} onValueChange={(v) => v && setStatus(v as FilterValue)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                {STATUS_ORDER.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name…"
                  className="h-8 w-52 pl-8"
                  aria-label="Filter by document name"
                />
              </div>
              <Select value={ownerId} onValueChange={(v) => setOwnerId(v ?? "all")}>
                <SelectTrigger size="sm" aria-label="Filter by owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All owners</SelectItem>
                  {owners.map(([id, name]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filtersActive && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X data-icon="inline-start" />
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          <div
            className={cn(
              "overflow-hidden rounded-xl border transition-shadow",
              tableShadow,
              "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
            )}
          >
            {list.length === 0 ? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>No documents match your filters</EmptyTitle>
                  <EmptyDescription>
                    Try a different name, owner, or status — or clear the filters to see
                    everything.
                  </EmptyDescription>
                </EmptyHeader>
                {filtersActive && (
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </Empty>
            ) : (
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-14" />
                  </TableRow>
                </TableHeader>
                <TableBody key={`${status}-${ownerId}-${query}`}>
                  {list.map((d, i) => (
                    <TableRow
                      key={d.id}
                      className={cn("cursor-pointer", stagger && "fancy-enter")}
                      style={stagger ? { animationDelay: `${Math.min(i * 35, 350)}ms` } : undefined}
                      onClick={() => setSelected(d)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                            <TypeIcon ext={d.ext} />
                          </span>
                          <span className="font-medium">{d.name}</span>
                          <span className="text-xs text-muted-foreground">.{d.ext}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={d.status} dot={fancy >= 2} />
                          {d.status === "publishing" && <StatusProgress doc={d} />}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{d.ownerName}</TableCell>
                      <TableCell className="text-muted-foreground">{d.size}</TableCell>
                      <TableCell className="text-muted-foreground">{d.updatedAt}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          <DownloadButton doc={d} onAction={onAction} />
                          <DocMenu doc={d} role={role} isOwner={isOwner(d)} onAction={onAction} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </section>

        {/* Detail panel */}
        {selected && (
          <aside
            className={cn(
              "hidden w-80 shrink-0 border-l p-5 transition-colors lg:block",
              fancy >= 5 ? "bg-background/70 backdrop-blur-md" : "bg-background",
              "motion-safe:animate-in motion-safe:slide-in-from-right-3 motion-safe:fade-in motion-safe:duration-200"
            )}
          >
            {fancy >= 4 && (
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/50 via-primary/15 to-transparent" />
            )}
            <div className="relative">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Document details</h2>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  <X />
                </Button>
              </div>
              <div className="mt-4">
                <DocDetailBody doc={selected} role={role} isOwner={isOwner(selected)} onAction={onAction} />
              </div>
            </div>
          </aside>
        )}
      </div>
    </AppShellA>
  )
}
