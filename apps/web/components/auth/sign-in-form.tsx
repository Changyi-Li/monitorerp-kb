"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

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
import { apiJson, type ApiErrorBody, type User } from "@/lib/api"
import { invalidateCurrentUserCache } from "@/lib/use-current-user"
import { cn } from "@/lib/utils"

/** The capability endpoint's enabled shape (issue #58): disabled otherwise. */
interface OidcConfig {
  enabled: boolean
  loginUrl?: string
}

export function SignInForm({ initialError = null }: { initialError?: string | null }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(initialError)
  const [submitting, setSubmitting] = useState(false)
  // The second door (issue #62): the login URL, present only when the API's
  // capability endpoint reports OIDC enabled. Until the fetch settles (or
  // when the API is unreachable) the button is absent — an unconfigured
  // deployment never renders it.
  const [oidcLoginUrl, setOidcLoginUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiJson<OidcConfig>("/api/auth/oidc/config")
      .then(({ body }) => {
        if (!cancelled && body.enabled === true && typeof body.loginUrl === "string" && body.loginUrl !== "") {
          setOidcLoginUrl(body.loginUrl)
        }
      })
      .catch(() => {
        // API unreachable — treat as disabled: no Keycloak button.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (initialError === null) return
    // The OIDC failure is a one-shot: drop the URL parameter so a refresh
    // does not re-show a stale failure (a password error already clears on
    // refresh — the message lives in component state only).
    window.history.replaceState(null, "", window.location.pathname)
  }, [initialError])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    const { status, body } = await apiJson<{ user?: User } | ApiErrorBody>("/api/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    })
    if (status === 200) {
      // The new session must not inherit the previous one's cached user,
      // or the UI would compute permissions with the wrong identity (issue #16).
      invalidateCurrentUserCache()
      router.replace("/")
      router.refresh()
      return
    }
    const apiError = (body as ApiErrorBody).error
    if (status === 401) setError("Invalid email or password")
    else if (status === 403) setError(apiError.message) // pending or deactivated, per the server
    else setError(apiError.message ?? "Something went wrong. Try again.")
    setSubmitting(false)
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Access the MonitorERP knowledge base</CardDescription>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <CardContent className="flex flex-col gap-4">
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="mt-4 flex-col gap-3">
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
          {oidcLoginUrl !== null && (
            <>
              <div aria-hidden className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or
                <div className="h-px flex-1 bg-border" />
              </div>
              {/* The API owns the flow: this same-origin link issues the flow
                  cookie and 302s to the issuer (issues #58, #61, #62). */}
              <a
                href={oidcLoginUrl}
                className={cn(buttonVariants({ variant: "outline" }), "w-full")}
              >
                Sign in with Keycloak
              </a>
            </>
          )}
          <p className="text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/auth/sign-up" className="text-primary underline-offset-4 hover:underline">
              Sign up
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
