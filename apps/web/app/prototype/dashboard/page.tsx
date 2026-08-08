"use client"

// PROTOTYPE — the documents surface: the winning structure (Variant A) at
// five fanciness levels. Cycle with the bar (or ← / → keys, or ?fancy=2..5).
// ?role=admin previews the super-admin view; ?motion=off compares static.
// Throwaway — the chosen level gets folded into the real build.

import { Suspense, useCallback, useState } from "react"
import { useSearchParams } from "next/navigation"

import { FANCY_LEVELS, type FancyLevel } from "@/components/prototype/fancy"
import type { Role } from "@/components/prototype/mock-data"
import { PrototypeSwitcher } from "@/components/prototype/prototype-switcher"
import { VariantA } from "@/components/prototype/variant-a"

export default function PrototypePage() {
  return (
    <Suspense fallback={null}>
      <PrototypeSurface />
    </Suspense>
  )
}

function PrototypeSurface() {
  const searchParams = useSearchParams()

  const rawFancy = Number(searchParams.get("fancy") ?? 1)
  const [fancy, setFancy] = useState<FancyLevel>(
    (FANCY_LEVELS.includes(rawFancy as FancyLevel) ? rawFancy : 1) as FancyLevel
  )
  const [role, setRole] = useState<Role>(
    searchParams.get("role") === "admin" ? "super_admin" : "member"
  )
  const [motion, setMotion] = useState(searchParams.get("motion") !== "off")
  const [lastAction, setLastAction] = useState<string | null>(null)

  const syncUrl = useCallback((f: FancyLevel, r: Role, m: boolean) => {
    window.history.pushState(
      null,
      "",
      `?fancy=${f}&role=${r === "super_admin" ? "admin" : "member"}${m ? "" : "&motion=off"}`
    )
  }, [])

  const handleFancyChange = useCallback(
    (f: FancyLevel) => {
      setFancy(f)
      syncUrl(f, role, motion)
      setLastAction(null)
    },
    [motion, role, syncUrl]
  )

  const handleRoleChange = useCallback(
    (r: Role) => {
      setRole(r)
      syncUrl(fancy, r, motion)
    },
    [fancy, motion, syncUrl]
  )

  const handleMotionToggle = useCallback(() => {
    setMotion((m) => {
      syncUrl(fancy, role, !m)
      return !m
    })
  }, [fancy, role, syncUrl])

  const handleAction = useCallback((message: string) => setLastAction(message), [])

  const fx = fancy >= 2 ? `fx-${fancy}` : ""
  const mesh = fancy >= 5 ? "fancy-mesh" : ""
  const noMotion = motion ? "" : "no-motion"

  return (
    <div className={`${fx} ${mesh} ${noMotion} bg-background pb-20`}>
      <VariantA fancy={fancy} role={role} onAction={handleAction} />
      <PrototypeSwitcher
        fancy={fancy}
        role={role}
        motion={motion}
        onFancyChangeAction={handleFancyChange}
        onRoleChangeAction={handleRoleChange}
        onMotionToggleAction={handleMotionToggle}
        lastAction={lastAction}
      />
    </div>
  )
}
