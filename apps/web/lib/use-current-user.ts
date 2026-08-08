import { useEffect, useState } from "react";

import { apiJson, type User } from "@/lib/api";

// Shared across components (shell + pages) so the session is fetched once.
let cached: Promise<User | null> | null = null;

/** The signed-in user (null until known). */
export function useCurrentUser(): User | null {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    cached ??= apiJson<{ user: User }>("/api/auth/me")
      .then(({ status, body }) => (status === 200 ? body.user : null))
      .catch(() => null);
    void cached.then((resolved) => {
      if (!cancelled) setUser(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return user;
}
