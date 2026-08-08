"use client";

import { ShieldAlert, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  listUsers,
  patchUser,
  type UserAdminItem,
  type UserListResult,
  type UserRole,
  type UserStatus,
} from "@/lib/users";
import { formatDate } from "@/lib/format";

const ROLE_LABELS: Record<UserRole, string> = {
  member: "Member",
  super_admin: "Super admin",
};

const STATUS_LABELS: Record<UserStatus, string> = {
  active: "Active",
  pending: "Pending",
  deactivated: "Deactivated",
};

const PAGE_SIZE = 20;

export function UsersPage() {
  const router = useRouter();
  const [status, setStatus] = useState<UserStatus | "">("");
  const [role, setRole] = useState<UserRole | "">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UserListResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const changeStatus = (next: UserStatus | ""): void => {
    setStatus(next);
    setPage(1);
  };
  const changeRole = (next: UserRole | ""): void => {
    setRole(next);
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    listUsers({ status: status === "" ? undefined : status, role: role === "" ? undefined : role, page, page_size: PAGE_SIZE })
      .then(({ status: resStatus, body }) => {
        if (cancelled) return;
        if (resStatus === 401) {
          router.replace("/auth/sign-in");
          return;
        }
        if (resStatus === 403) {
          setForbidden(true);
          return;
        }
        setData(body);
        setForbidden(false);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load users. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [status, role, page, refreshKey, router]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const pendingCount = data?.counts.pending ?? 0;
  const filtersActive = status !== "" || role !== "";

  const clearFilters = (): void => {
    changeStatus("");
    changeRole("");
  };

  const act = async (user: UserAdminItem, body: { role?: UserRole; status?: UserStatus }, label: string): Promise<void> => {
    setBusyId(user.id);
    setError(null);
    const result = await patchUser(user.id, body);
    if (result.status === 200) {
      setRefreshKey((k) => k + 1);
    } else if (result.status === 409) {
      setError(result.body.error?.message ?? `Could not ${label}.`);
    } else if (result.status === 403) {
      setForbidden(true);
    } else {
      setError(result.body.error?.message ?? `Could not ${label}. Try again.`);
    }
    setBusyId(null);
  };

  const actionsFor = (user: UserAdminItem): Array<{ label: string; body: { role?: UserRole; status?: UserStatus }; disabled: boolean }> => {
    switch (user.status) {
      case "pending":
        return [{ label: "Activate", body: { status: "active" }, disabled: false }];
      case "deactivated":
        return [
          { label: "Reactivate", body: { status: "active" }, disabled: false },
          ...(user.role === "member"
            ? [{ label: "Promote to super admin", body: { role: "super_admin" as const }, disabled: false }]
            : [{ label: "Demote to member", body: { role: "member" as const }, disabled: user.is_last_admin }]),
        ];
      case "active":
        if (user.role === "member") {
          return [
            { label: "Promote to super admin", body: { role: "super_admin" as const }, disabled: false },
            { label: "Deactivate", body: { status: "deactivated" }, disabled: false },
          ];
        }
        return [
          { label: "Demote to member", body: { role: "member" }, disabled: user.is_last_admin },
          { label: "Deactivate", body: { status: "deactivated" }, disabled: user.is_last_admin },
        ];
    }
  };

  const loading = data === null && !forbidden && error === null;

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="size-5 text-muted-foreground" aria-hidden />
            Users
          </h1>
          <p className="text-sm text-muted-foreground">Manage users and access</p>
        </div>
        {pendingCount > 0 && (
          <Badge variant="default" title={`${pendingCount} ${pendingCount === 1 ? "user" : "users"} awaiting activation`}>
            {pendingCount} pending {pendingCount === 1 ? "activation" : "activations"}
          </Badge>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {error !== null && (
          <p role="alert" className="border-b px-6 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {forbidden ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <h2 className="text-base font-semibold">Super admins only</h2>
              <p className="text-sm text-muted-foreground">
                User administration is limited to super admins.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
              <select
                value={status}
                onChange={(e) => changeStatus(e.target.value as UserStatus | "")}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={role}
                onChange={(e) => changeRole(e.target.value as UserRole | "")}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
                aria-label="Filter by role"
              >
                <option value="">All roles</option>
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="ml-auto text-sm text-muted-foreground">
                Showing {items.length} of {data?.total ?? 0}
              </p>
              {filtersActive && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>

            {loading ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-sm text-muted-foreground">Loading users…</p>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-sm text-muted-foreground">
                  {filtersActive ? "No users match your filters." : "No users yet."}
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-6 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Role</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Joined</th>
                      <th className="px-4 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((user) => (
                      <tr key={user.id} className="border-b">
                        <td className="px-6 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{user.name}</span>
                            {user.is_last_admin && (
                              <Badge variant="outline" title="The last active super admin cannot be demoted or deactivated">
                                <ShieldAlert className="size-3" aria-hidden />
                                Last super admin
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{user.email}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={user.role === "super_admin" ? "default" : "secondary"}>
                            {ROLE_LABELS[user.role]}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            variant={
                              user.status === "active" ? "default" : user.status === "pending" ? "outline" : "destructive"
                            }
                          >
                            {STATUS_LABELS[user.status]}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{formatDate(user.created_at)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {actionsFor(user).map((action) => (
                              <Button
                                key={action.label}
                                variant="outline"
                                size="xs"
                                disabled={action.disabled || busyId === user.id}
                                title={action.disabled ? "Protected — the last active super admin cannot be changed" : undefined}
                                onClick={() => void act(user, action.body, action.label.toLowerCase())}
                              >
                                {busyId === user.id ? "…" : action.label}
                              </Button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data !== null && data.total > PAGE_SIZE && (
                  <div className="flex items-center justify-end gap-3 px-6 py-3">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      Page {data.page} of {Math.max(1, Math.ceil(data.total / data.page_size))}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= Math.ceil(data.total / data.page_size)}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
