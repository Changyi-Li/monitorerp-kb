import { BookOpen, FileText, MessageSquare, Users } from "lucide-react";

import { cn } from "@/lib/utils";

const DATASET_NAME = process.env.NEXT_PUBLIC_DATASET_NAME ?? "monitorerp-china-internal";

// PROTOTYPE mock shell — mimics the real AppShell so the chat variants are seen
// in context (Chat alongside Documents/Users), but with NO API calls and NO
// auth. This keeps the prototype viewable without the backend or a login.
export function PrototypeShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-2 px-4 pt-4 pb-1">
          <BookOpen className="size-5 text-primary" aria-hidden />
          <span className="text-sm font-semibold">MonitorERP KB</span>
        </div>
        <p className="truncate px-4 pb-3 text-xs text-muted-foreground" title="Dataset">
          {DATASET_NAME}
        </p>
        <nav className="flex flex-col gap-1 px-2" aria-label="Main">
          <span className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground">
            <FileText className="size-4" aria-hidden /> Documents
          </span>
          <span
            aria-current="page"
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium",
              "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <MessageSquare className="size-4" aria-hidden /> Chat
            <span className="ml-auto rounded bg-primary/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              proto
            </span>
          </span>
          <span className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground">
            <Users className="size-4" aria-hidden /> Users
          </span>
        </nav>
        <div className="mt-auto border-t p-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium">Prototype Viewer</span>
            <span className="w-fit rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">Member</span>
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
    </div>
  );
}
