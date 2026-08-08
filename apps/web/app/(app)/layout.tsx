import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";

// The shell is only reachable with a session cookie; the API validates the
// cookie itself on every request (see /api/auth/me in the app shell).
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  if (!cookieStore.has("kb_session")) redirect("/auth/sign-in");
  return <AppShell>{children}</AppShell>;
}
