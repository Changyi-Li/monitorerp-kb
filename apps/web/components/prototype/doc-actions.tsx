// PROTOTYPE — shared action logic and small presenters for the UI prototype.
// The per-status / per-role action RULES are shared across variants; the
// layout is not (each variant renders them its own way).

import {
  Check,
  Download,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  MoreHorizontal,
  Presentation,
  RefreshCcw,
  Send,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import { DATASET, STATUS_LABELS, type Doc, type DocStatus, type Role } from "./mock-data"

export type DocAction = "promote" | "publish" | "retry" | "withdraw" | "delete"

/** The locked permission rules: owner can change status of their own docs;
 *  super admin can additionally publish others' ready docs and withdraw any doc. */
export function actionsFor(doc: Doc, role: Role, isOwner: boolean): DocAction[] {
  const can = isOwner || role === "super_admin"
  switch (doc.status) {
    case "draft":
      return isOwner ? ["promote", "delete"] : []
    case "ready":
      return can ? ["publish", "delete"] : []
    case "publishing":
      return []
    case "published":
      return can ? ["withdraw", "delete"] : []
    case "failed": {
      const actions: DocAction[] = []
      if (can && doc.retriesLeft && doc.retriesLeft > 0) actions.push("retry")
      if (can) actions.push("withdraw")
      if (can) actions.push("delete")
      return actions
    }
  }
}

export const ACTION_LABELS: Record<DocAction, string> = {
  promote: "Mark ready",
  publish: "Publish",
  retry: "Retry parse",
  withdraw: "Withdraw",
  delete: "Delete",
}

const ACTION_ICONS: Record<DocAction, LucideIcon> = {
  promote: Check,
  publish: Send,
  retry: RefreshCcw,
  withdraw: Undo2,
  delete: Trash2,
}

const STATUS_DOT: Record<DocStatus, string> = {
  draft: "bg-muted-foreground/40",
  ready: "bg-primary/60",
  publishing: "bg-primary fancy-pulse",
  published: "bg-emerald-500",
  failed: "bg-destructive",
}

/** `dot` adds a colored status dot (fanciness level 2+). */
export function StatusBadge({ status, dot = false }: { status: DocStatus; dot?: boolean }) {
  switch (status) {
    case "draft":
      return (
        <Badge variant="secondary">
          {dot && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.draft)} />}
          {STATUS_LABELS.draft}
        </Badge>
      )
    case "ready":
      return (
        <Badge variant="outline">
          {dot && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.ready)} />}
          {STATUS_LABELS.ready}
        </Badge>
      )
    case "publishing":
      return (
        <Badge variant="default">
          {dot && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.publishing)} />}
          {STATUS_LABELS.publishing}
        </Badge>
      )
    case "published":
      return (
        <Badge variant="outline">
          {dot && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.published)} />}
          <Check data-icon="inline-start" />
          {STATUS_LABELS.published}
        </Badge>
      )
    case "failed":
      return (
        <Badge variant="destructive">
          {dot && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.failed)} />}
          {STATUS_LABELS.failed}
        </Badge>
      )
  }
}

const EXT_ICONS: Record<string, LucideIcon> = {
  pdf: FileText,
  md: FileCode2,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
}

export function TypeIcon({ ext, className }: { ext: string; className?: string }) {
  const Icon = EXT_ICONS[ext] ?? File
  return <Icon className={className ?? "size-4 text-muted-foreground"} />
}

/** Inline parse progress — only meaningful while publishing. */
export function StatusProgress({ doc, className }: { doc: Doc; className?: string }) {
  if (doc.status !== "publishing") return null
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Progress value={doc.progress ?? null} className="h-1.5 w-20" />
      <span className="text-xs tabular-nums text-muted-foreground">{doc.progress}%</span>
    </div>
  )
}

export function DownloadButton({
  doc,
  onAction,
}: {
  doc: Doc
  onAction: (message: string) => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Download ${doc.name}`}
      onClick={() => onAction(`Download — ${doc.name}`)}
    >
      <Download />
    </Button>
  )
}

/** The primary lifecycle action for a doc (first non-delete action), as a button. */
export function PrimaryActionButton({
  doc,
  role,
  isOwner,
  onAction,
  size = "sm",
}: {
  doc: Doc
  role: Role
  isOwner: boolean
  onAction: (message: string) => void
  size?: "xs" | "sm" | "default"
}) {
  const primary = actionsFor(doc, role, isOwner).find((a) => a !== "delete")
  if (!primary) return null
  const Icon = ACTION_ICONS[primary]
  return (
    <Button size={size} onClick={() => onAction(`${ACTION_LABELS[primary]} — ${doc.name}`)}>
      <Icon data-icon="inline-start" />
      {ACTION_LABELS[primary]}
    </Button>
  )
}

/** The "⋯" menu with every action the role is allowed for the doc. */
export function DocMenu({
  doc,
  role,
  isOwner,
  onAction,
}: {
  doc: Doc
  role: Role
  isOwner: boolean
  onAction: (message: string) => void
}) {
  const actions = actionsFor(doc, role, isOwner)
  if (actions.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${doc.name}`} />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => {
          const Icon = ACTION_ICONS[a]
          return (
            <DropdownMenuItem
              key={a}
              variant={a === "delete" ? "destructive" : "default"}
              onClick={() => onAction(`${ACTION_LABELS[a]} — ${doc.name}`)}
            >
              <Icon />
              {ACTION_LABELS[a]}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The action buttons block used in detail surfaces (side panel / dialog). */
export function ActionButtons({
  doc,
  role,
  isOwner,
  onAction,
}: {
  doc: Doc
  role: Role
  isOwner: boolean
  onAction: (message: string) => void
}) {
  const actions = actionsFor(doc, role, isOwner)
  if (actions.length === 0) {
    return <p className="text-xs text-muted-foreground">No actions available for this document.</p>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => {
        const Icon = ACTION_ICONS[a]
        return (
          <Button
            key={a}
            size="sm"
            variant={a === "delete" ? "destructive" : "default"}
            onClick={() => onAction(`${ACTION_LABELS[a]} — ${doc.name}`)}
          >
            <Icon data-icon="inline-start" />
            {ACTION_LABELS[a]}
          </Button>
        )
      })}
    </div>
  )
}

/** Full detail body used by every variant's detail surface. */
export function DocDetailBody({
  doc,
  role,
  isOwner,
  onAction,
}: {
  doc: Doc
  role: Role
  isOwner: boolean
  onAction: (message: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <TypeIcon ext={doc.ext} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium">{doc.name}</p>
            <p className="text-xs text-muted-foreground">
              {doc.ext.toUpperCase()} · {doc.size}
            </p>
          </div>
        </div>
        <StatusBadge status={doc.status} />
      </div>
      <Separator />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          {doc.ownerName}
          {isOwner && <span className="text-muted-foreground"> (you)</span>}
        </dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>{doc.updatedAt}</dd>
        {doc.status === "published" && (
          <>
            <dt className="text-muted-foreground">Dataset</dt>
            <dd className="font-mono text-xs">{DATASET}</dd>
            <dt className="text-muted-foreground">Chunks</dt>
            <dd>{doc.chunks}</dd>
          </>
        )}
        {doc.status === "publishing" && (
          <>
            <dt className="text-muted-foreground">Parsing</dt>
            <dd>
              <StatusProgress doc={doc} />
            </dd>
          </>
        )}
        {doc.status === "failed" && (
          <>
            <dt className="text-muted-foreground">Retries left</dt>
            <dd>{doc.retriesLeft} of 3</dd>
          </>
        )}
      </dl>
      {doc.status === "failed" && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-sm text-destructive">
          Parsing failed — the document was rejected by RagFlow. Retry up to {doc.retriesLeft}{" "}
          more times, or withdraw and mark it ready again.
        </div>
      )}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">History</p>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {doc.history.map((h) => (
            <li key={h} className="flex items-center gap-1.5">
              <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
              {h}
            </li>
          ))}
        </ul>
      </div>
      <Separator />
      <ActionButtons doc={doc} role={role} isOwner={isOwner} onAction={onAction} />
    </div>
  )
}
