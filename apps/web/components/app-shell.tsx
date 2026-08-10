"use client"

import { BookOpen, FileText, LogOut, MessageSquare, Users } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"

// Display name of the configured RagFlow dataset (config-driven per #6;
// deployments override NEXT_PUBLIC_DATASET_NAME).
const DATASET_NAME = process.env.NEXT_PUBLIC_DATASET_NAME ?? "monitorerp-china-internal"

import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { apiJson, type User } from "@/lib/api"
import { invalidateCurrentUserCache } from "@/lib/use-current-user"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { href: "/", label: "Documents", icon: FileText },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/users", label: "Users", icon: Users, adminOnly: true },
] as const

// The Users screen is super-admin only (the API answers 403 for members).
const visibleNavItems = (role: User["role"] | undefined): Array<(typeof NAV_ITEMS)[number]> =>
  NAV_ITEMS.filter((item) => !("adminOnly" in item) || item.adminOnly !== true || role === "super_admin")

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const [state, setState] = useState<"loading" | "ready">("loading")

  useEffect(() => {
    let cancelled = false
    apiJson<{ user: User }>("/api/auth/me")
      .then(({ status, body }) => {
        if (cancelled) return
        if (status === 401) {
          // Session missing or invalidated server-side — back to sign-in.
          router.replace("/auth/sign-in")
          return
        }
        setUser(body.user)
        setState("ready")
      })
      .catch(() => {
        if (!cancelled) router.replace("/auth/sign-in")
      })
    return () => {
      cancelled = true
    }
  }, [router])

  const signOut = async (): Promise<void> => {
    await apiJson("/api/auth/sign-out", { method: "POST" })
    // The next session must not inherit this one's cached user (issue #16).
    invalidateCurrentUserCache()
    router.replace("/auth/sign-in")
    router.refresh()
  }

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
          {visibleNavItems(user?.role).map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t p-3">
          {state === "ready" && user !== null && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-medium">{user.name}</span>
                <Badge variant={user.role === "super_admin" ? "default" : "secondary"}>
                  {user.role === "super_admin" ? "Super admin" : "Member"}
                </Badge>
              </div>
              <ThemeToggle />
            </div>
          )}
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => void signOut()}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
    </div>
  )
}
