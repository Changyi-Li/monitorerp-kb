"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"

import { AppShellA } from "@/components/prototype/app-shell-a"
import { FANCY_LEVELS, type FancyLevel } from "@/components/prototype/fancy"
import type { Role } from "@/components/prototype/mock-data"
import { AdminUsersScreen } from "@/components/prototype/shared-screens"

export default function UsersPage() {
  return (
    <Suspense fallback={null}>
      <UsersSurface />
    </Suspense>
  )
}

function UsersSurface() {
  const searchParams = useSearchParams()
  const [fancy] = useState<FancyLevel>(
    (FANCY_LEVELS.includes(Number(searchParams.get("fancy")) as FancyLevel)
      ? Number(searchParams.get("fancy"))
      : 1) as FancyLevel
  )
  const role: Role = searchParams.get("role") === "admin" ? "super_admin" : "member"
  return (
    <AppShellA active="users" role={role} fancy={fancy}>
      <AdminUsersScreen />
    </AppShellA>
  )
}
