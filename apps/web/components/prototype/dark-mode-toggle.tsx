"use client"

// PROTOTYPE — light/dark toggle. Applies the `dark` class to <html> (the
// shadcn/Tailwind class-based dark mode) and persists the choice locally.

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"

const STORAGE_KEY = "prototype-dark"

export function DarkModeToggle() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    const initial = stored === "1"
    setDark(initial)
    document.documentElement.classList.toggle("dark", initial)
  }, [])

  const toggle = () => {
    setDark((d) => {
      const next = !d
      document.documentElement.classList.toggle("dark", next)
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
      return next
    })
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
