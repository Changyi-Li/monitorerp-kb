"use client"

import { CheckCircle2 } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiJson, type ApiErrorBody } from "@/lib/api"
import { cn } from "@/lib/utils"

export function SignUpForm() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState(false)

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    const { status, body } = await apiJson<ApiErrorBody>("/api/auth/sign-up", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    })
    if (status === 201) {
      setCreated(true)
      return
    }
    const apiError = (body as ApiErrorBody).error
    if (status === 409) setError("An account with this email already exists")
    else if (status === 400) {
      const fields = apiError.fields ?? {}
      const first = Object.values(fields).flat()[0]
      setError(first ?? "Please check the form and try again")
    } else setError(apiError.message ?? "Something went wrong. Try again.")
    setSubmitting(false)
  }

  if (created) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" aria-hidden />
            Account created
          </CardTitle>
          <CardDescription>
            Your account is awaiting activation by a super admin. You&apos;ll be able to sign in
            once it&apos;s activated.
          </CardDescription>
        </CardHeader>
        <CardFooter className="mt-4">
          <Link href="/auth/sign-in" className={cn(buttonVariants({ className: "w-full" }))}>
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign up</CardTitle>
        <CardDescription>Create an account to join the knowledge base</CardDescription>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters</p>
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="mt-4 flex-col gap-3">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/auth/sign-in" className="text-primary underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
