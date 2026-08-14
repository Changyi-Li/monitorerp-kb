import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4801";

// The shell is only reachable with a session cookie; the API validates the
// cookie itself on every request (see /api/auth/me in the app shell).
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  if (!cookieStore.has("kb_session")) redirect("/auth/sign-in");

  // Issue #40: the dataset display name is derived at runtime — the API reads
  // it from the configured RagFlow dataset — never baked into the client
  // bundle at build time. A fetch failure (RagFlow down) degrades to no
  // sidebar name, never a stale codename.
  let datasetName: string | undefined;
  try {
    const res = await fetch(`${API_ORIGIN}/dataset`, {
      headers: { cookie: cookieStore.toString() },
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { name?: unknown };
      if (typeof body.name === "string") datasetName = body.name;
    }
  } catch {
    // RagFlow down — leave datasetName undefined (no sidebar name, never a
    // stale codename).
  }

  return <AppShell datasetName={datasetName}>{children}</AppShell>;
}
