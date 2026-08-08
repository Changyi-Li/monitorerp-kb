"use client"

// PROTOTYPE — screens that don't vary across the design: sign-in, sign-up
// (with the pending-activation state), and the admin users screen.

import { useState } from "react"
import Link from "next/link"
import { Check, Clock3, FileText, ShieldCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { users as initialUsers, type AppUser, type UserStatus } from "./mock-data"

function AppLogo() {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <FileText className="size-4" />
      </span>
      <span className="text-sm font-medium">Doc Manager</span>
    </div>
  )
}

const FIELD = "flex flex-col gap-1.5"

function UserStatusBadge({ status }: { status: UserStatus }) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline">
          <Check data-icon="inline-start" />
          Active
        </Badge>
      )
    case "pending":
      return (
        <Badge variant="secondary">
          <Clock3 data-icon="inline-start" />
          Pending
        </Badge>
      )
    case "deactivated":
      return <Badge variant="destructive">Deactivated</Badge>
  }
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

// ---- Sign in ----

export function SignInScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <AppLogo />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Internal RAG document manager</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className={FIELD}>
            <Label htmlFor="si-email">Email</Label>
            <Input id="si-email" type="email" placeholder="you@monitorerp.cn" />
          </div>
          <div className={FIELD}>
            <Label htmlFor="si-password">Password</Label>
            <Input id="si-password" type="password" placeholder="••••••••" />
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button className="w-full">Sign in</Button>
          <p className="text-center text-xs text-muted-foreground">
            No account?{" "}
            <Link
              href="/prototype/dashboard/sign-up"
              className="text-primary underline underline-offset-4 hover:opacity-80"
            >
              Create one
            </Link>
          </p>
        </CardFooter>
      </Card>
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        PROTOTYPE — no real auth. New accounts start pending until a super admin activates them.
      </p>
    </div>
  )
}

// ---- Sign up (with pending-activation state) ----

export function SignUpScreen() {
  const [submitted, setSubmitted] = useState(false)

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <AppLogo />
      {submitted ? (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Account created</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert>
              <AlertTitle>Awaiting activation</AlertTitle>
              <AlertDescription>
                A super admin must activate your account before you can sign in. You&apos;ll be
                able to sign in once it&apos;s been activated.
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter>
            <Button variant="outline" className="w-full" onClick={() => setSubmitted(false)}>
              Go back
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Create account</CardTitle>
            <CardDescription>
              Your account will be activated by a super admin before you can sign in.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className={FIELD}>
              <Label htmlFor="su-name">Name</Label>
              <Input id="su-name" placeholder="Your name" />
            </div>
            <div className={FIELD}>
              <Label htmlFor="su-email">Email</Label>
              <Input id="su-email" type="email" placeholder="you@monitorerp.cn" />
            </div>
            <div className={FIELD}>
              <Label htmlFor="su-password">Password</Label>
              <Input id="su-password" type="password" placeholder="At least 8 characters" />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => setSubmitted(true)}>
              Create account
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link
                href="/prototype/dashboard/sign-in"
                className="text-primary underline underline-offset-4 hover:opacity-80"
              >
                Sign in
              </Link>
            </p>
          </CardFooter>
        </Card>
      )}
    </div>
  )
}

// ---- Admin users ----

export function AdminUsersScreen() {
  const [rows, setRows] = useState(initialUsers)
  const activeAdmins = rows.filter((u) => u.role === "super_admin" && u.status === "active")
  const isLastAdmin = (u: AppUser) =>
    u.role === "super_admin" && u.status === "active" && activeAdmins.length <= 1

  const patch = (id: string, p: Partial<AppUser>) =>
    setRows((rs) => rs.map((u) => (u.id === id ? { ...u, ...p } : u)))

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-medium">Users</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} users · {rows.filter((u) => u.status === "pending").length} awaiting
          activation
        </p>
      </div>

      <Alert className="mt-4">
        <AlertTitle>PROTOTYPE</AlertTitle>
        <AlertDescription>
          Local state only — nothing persists. The last active super admin can&apos;t be demoted or
          deactivated.
        </AlertDescription>
      </Alert>

      <div className="mt-4 overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Avatar className="size-7">
                      <AvatarFallback>{initials(u.name)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {u.name}
                        {u.id === "u1" && (
                          <span className="font-normal text-muted-foreground"> (you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {u.role === "super_admin" ? (
                    <Badge variant="default">
                      <ShieldCheck data-icon="inline-start" />
                      Super admin
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Member</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <UserStatusBadge status={u.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{u.joinedAt}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    {isLastAdmin(u) ? (
                      <Badge variant="outline">last admin</Badge>
                    ) : (
                      <>
                        {u.status === "pending" && (
                          <Button size="sm" onClick={() => patch(u.id, { status: "active" })}>
                            Activate
                          </Button>
                        )}
                        {u.status === "active" && u.role === "member" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => patch(u.id, { role: "super_admin" })}
                            >
                              Promote to admin
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:bg-destructive/10"
                              onClick={() => patch(u.id, { status: "deactivated" })}
                            >
                              Deactivate
                            </Button>
                          </>
                        )}
                        {u.status === "active" && u.role === "super_admin" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => patch(u.id, { role: "member" })}
                            >
                              Demote to member
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:bg-destructive/10"
                              onClick={() => patch(u.id, { status: "deactivated" })}
                            >
                              Deactivate
                            </Button>
                          </>
                        )}
                        {u.status === "deactivated" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => patch(u.id, { status: "active" })}
                          >
                            Reactivate
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        PROTOTYPE — in the real build, user management lives in the app&apos;s own database.
      </p>
    </div>
  )
}
