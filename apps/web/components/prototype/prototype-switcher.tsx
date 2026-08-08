"use client"

// PROTOTYPE chrome — the floating comparison bar. Not part of any design:
// it cycles the five fanciness levels, previews roles, and toggles motion.
// Hidden in production builds.

import { useEffect } from "react"
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"

import { FANCY_LEVELS, FANCY_NAMES, type FancyLevel } from "./fancy"
import type { Role } from "./mock-data"

export function PrototypeSwitcher({
  fancy,
  role,
  motion,
  onFancyChangeAction,
  onRoleChangeAction,
  onMotionToggleAction,
  lastAction,
}: {
  fancy: FancyLevel
  role: Role
  motion: boolean
  onFancyChangeAction: (level: FancyLevel) => void
  onRoleChangeAction: (role: Role) => void
  onMotionToggleAction: () => void
  lastAction: string | null
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return
      }
      const i = FANCY_LEVELS.indexOf(fancy)
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        onFancyChangeAction(FANCY_LEVELS[(i + FANCY_LEVELS.length - 1) % FANCY_LEVELS.length])
      }
      if (e.key === "ArrowRight") {
        e.preventDefault()
        onFancyChangeAction(FANCY_LEVELS[(i + 1) % FANCY_LEVELS.length])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fancy, onFancyChangeAction])

  if (process.env.NODE_ENV === "production") return null

  const cycle = (dir: 1 | -1) => {
    const i = FANCY_LEVELS.indexOf(fancy)
    onFancyChangeAction(FANCY_LEVELS[(i + dir + FANCY_LEVELS.length) % FANCY_LEVELS.length])
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-1.5 pl-1 text-sm shadow-lg ring-1 ring-foreground/10">
      <Button variant="ghost" size="icon-sm" aria-label="Previous level" onClick={() => cycle(-1)}>
        <ChevronLeft />
      </Button>
      <span className="font-medium">
        F{fancy} — {FANCY_NAMES[fancy]}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Next level" onClick={() => cycle(1)}>
        <ChevronRight />
      </Button>
      <Separator orientation="vertical" className="h-4" />
      <Select value={role} onValueChange={(r) => onRoleChangeAction((r ?? "member") as Role)}>
        <SelectTrigger size="sm" aria-label="View as role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="member">View as Member</SelectItem>
          <SelectItem value="super_admin">View as Super admin</SelectItem>
        </SelectContent>
      </Select>
      <Separator orientation="vertical" className="h-4" />
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={motion}
        aria-label={motion ? "Turn animation off" : "Turn animation on"}
        onClick={onMotionToggleAction}
      >
        <Sparkles data-icon="inline-start" />
        {motion ? "On" : "Off"}
      </Button>
      {lastAction && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <span className="max-w-56 truncate text-xs text-muted-foreground">
            proto: {lastAction}
          </span>
        </>
      )}
    </div>
  )
}
