import { apiJson, type ApiErrorBody, type ApiResult } from "@/lib/api";

export type UserRole = "member" | "super_admin";
export type UserStatus = "active" | "pending" | "deactivated";

export interface UserAdminItem {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  is_last_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserListResult {
  items: UserAdminItem[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<UserStatus, number>;
}

export interface UserPatchResult {
  error?: ApiErrorBody["error"];
}

export function listUsers(filters: {
  status?: UserStatus;
  role?: UserRole;
  page?: number;
  page_size?: number;
}): Promise<ApiResult<UserListResult>> {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.role !== undefined) params.set("role", filters.role);
  params.set("page", String(filters.page ?? 1));
  params.set("page_size", String(filters.page_size ?? 20));
  return apiJson<UserListResult>(`/api/users?${params.toString()}`);
}

export async function patchUser(
  id: string,
  body: { role?: UserRole; status?: UserStatus },
): Promise<ApiResult<UserPatchResult>> {
  const res = await apiJson<UserPatchResult>(`/api/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res;
}
