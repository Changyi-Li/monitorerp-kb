"use client"

// PROTOTYPE — the Variant A app shell (sidebar + main), shared by the
// documents surface and the users screen. Fanciness levels 2-5 progressively
// dress up the sidebar.

import Link from "next/link"
import { Files, Library, LogOut, ShieldCheck, Users as UsersIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import { DarkModeToggle } from "./dark-mode-toggle"
import type { FancyLevel } from "./fancy"
import { currentUser, type Role } from "./mock-data"

export type ShellSection = "documents" | "users"

const NAV_ITEM =
  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
const NAV_ITEM_ACTIVE_L1 = "bg-background text-foreground shadow-sm hover:bg-background"
const NAV_ITEM_ACTIVE_FANCY = "bg-primary/10 text-primary hover:bg-primary/10"

export function AppShellA({
  active,
  role,
  fancy,
  children,
}: {
  active: ShellSection
  role: Role
  fancy: FancyLevel
  children: React.ReactNode
}) {
  const navActive = cn(NAV_ITEM, fancy >= 2 ? NAV_ITEM_ACTIVE_FANCY : NAV_ITEM_ACTIVE_L1)
  const sidebarGlass = fancy >= 5 ? "bg-muted/30 backdrop-blur-md" : "bg-muted/40"
  const logoTile =
    fancy >= 3
      ? "bg-gradient-to-br from-primary to-primary/70 shadow-md shadow-primary/25"
      : "bg-primary shadow-sm"

  return (
    <div className="flex min-h-dvh">
      <aside
        className={cn(
          "sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r transition-colors duration-300",
          sidebarGlass
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg text-primary-foreground",
              logoTile
            )}
          >
            <Library className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm leading-none font-semibold">Doc Manager</p>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              monitorerp-china-internal
            </p>
          </div>
        </div>
        <Separator />
        <nav className="flex flex-col gap-1 p-2">
          <Link href="/prototype/dashboard" className={cn(navActive, active === "documents" && navActive)}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-md",
                active === "documents" && fancy >= 4 && "bg-primary/15"
              )}
            >
              <Files className="size-4" />
            </span>
            Documents
          </Link>
          <Link
            href="/prototype/dashboard/users"
            className={active === "users" ? navActive : NAV_ITEM}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-md",
                active === "users" && fancy >= 4 && "bg-primary/15"
              )}
            >
              <UsersIcon className="size-4" />
            </span>
            Users
          </Link>
          <Link href="/prototype/dashboard/sign-in" className={NAV_ITEM}>
            <span className="flex size-6 items-center justify-center rounded-md">
              <LogOut className="size-4" />
            </span>
            Sign out
          </Link>
        </nav>
        <div className="mt-auto border-t p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
            <Avatar className="size-8">
              <AvatarFallback>LW</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{currentUser.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {role === "super_admin" ? "Super admin" : "Member"}
              </p>
            </div>
            <DarkModeToggle />
            {role === "super_admin" && <ShieldCheck className="size-4 shrink-0 text-primary" />}
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
