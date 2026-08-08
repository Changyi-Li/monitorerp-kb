export interface User {
  id: string;
  name: string;
  email: string;
  role: "member" | "super_admin";
  status: "active" | "pending" | "deactivated";
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string[]> };
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

/** Same-origin JSON call to the API (proxied by next.config rewrites). */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json().catch(() => undefined)) as T;
  return { status: res.status, body };
}
