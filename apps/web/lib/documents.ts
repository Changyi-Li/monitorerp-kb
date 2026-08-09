import { apiJson, type ApiErrorBody, type ApiResult } from "@/lib/api";

export type DocumentStatus = "draft" | "publishing" | "published" | "failed";

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
};

export const STATUS_ORDER: DocumentStatus[] = ["draft", "publishing", "published", "failed"];

export interface DocumentOwner {
  id: string;
  name: string;
}

export interface DocumentItem {
  id: string;
  name: string;
  ext: string;
  size_bytes: number;
  status: DocumentStatus;
  owner: DocumentOwner;
  progress: number;
  chunk_count: number;
  chunk_method: string;
  retries_left: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  published_at?: string;
}

export interface DocumentListResult {
  items: DocumentItem[];
  total: number;
  page: number;
  page_size: number;
  /** Corpus-wide per-status counts (independent of filters) — feeds the KPI strip. */
  counts: Record<DocumentStatus, number>;
}

export interface HistoryEntry {
  id: string;
  actor: DocumentOwner;
  from_status: DocumentStatus | null;
  to_status: DocumentStatus;
  note: string | null;
  created_at: string;
}

export interface DocumentDetail {
  document: DocumentItem;
  history: HistoryEntry[];
}

export interface DocumentFilters {
  status?: DocumentStatus;
  q?: string;
  owner_id?: string;
  page?: number;
  page_size?: number;
}

function queryString(filters: DocumentFilters): string {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.q !== undefined && filters.q !== "") params.set("q", filters.q);
  if (filters.owner_id !== undefined && filters.owner_id !== "") params.set("owner_id", filters.owner_id);
  params.set("page", String(filters.page ?? 1));
  params.set("page_size", String(filters.page_size ?? 20));
  return params.toString();
}

export function listDocuments(filters: DocumentFilters): Promise<ApiResult<DocumentListResult>> {
  return apiJson<DocumentListResult>(`/api/documents?${queryString(filters)}`);
}

export function getDocument(id: string): Promise<ApiResult<DocumentDetail>> {
  return apiJson<DocumentDetail>(`/api/documents/${id}`);
}

export interface UploadResult {
  document?: DocumentItem;
  error?: ApiErrorBody["error"];
}

export type DocumentAction = "publish" | "retry" | "withdraw";

export interface DocumentActionResult {
  document?: DocumentItem;
  error?: ApiErrorBody["error"];
}

export function documentAction(
  id: string,
  action: DocumentAction,
): Promise<ApiResult<DocumentActionResult>> {
  return apiJson<DocumentActionResult>(`/api/documents/${id}/${action}`, { method: "POST" });
}

export async function deleteDocument(id: string): Promise<ApiResult<DocumentActionResult>> {
  const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
  const body = ((await res.json().catch(() => undefined)) as DocumentActionResult | undefined) ?? {};
  return { status: res.status, body };
}

export interface DocumentActionOption {
  label: string;
  action: DocumentAction | "delete";
  destructive?: boolean;
}

/**
 * The actions a user may take on a document, mirroring the locked permission
 * matrix: non-owner members see download only; publish/retry/withdraw/delete
 * are owner-or-super-admin (an owner publishes their own draft, a super admin
 * may publish any draft).
 */
export function documentActionsFor(document: DocumentItem, userId: string, role: string): DocumentActionOption[] {
  if (document.status === "publishing") return [];
  const isOwner = document.owner.id === userId;
  const isAdmin = role === "super_admin";
  if (!isOwner && !isAdmin) return [];

  const actions: DocumentActionOption[] = [];
  switch (document.status) {
    case "draft":
      actions.push({ label: "Publish", action: "publish" });
      break;
    case "failed":
      actions.push({ label: "Retry", action: "retry" });
      actions.push({ label: "Withdraw", action: "withdraw" });
      break;
    case "published":
      actions.push({ label: "Withdraw", action: "withdraw" });
      break;
  }
  actions.push({ label: "Delete", action: "delete", destructive: true });
  return actions;
}

/** Multipart upload — no JSON content-type; fetch sets the boundary. */
export async function uploadDocument(file: File): Promise<ApiResult<UploadResult>> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/documents", { method: "POST", body: form });
  const body = ((await res.json().catch(() => undefined)) as UploadResult | undefined) ?? {};
  return { status: res.status, body };
}
