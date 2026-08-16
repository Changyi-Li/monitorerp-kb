import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Issue #62: the API-owned OIDC callback (issue #61) redirects a failed
 * sign-in to the web origin root with `?error=oidc_failed`. From there the
 * app shell layout bounces an unauthenticated browser to `/auth/sign-in` —
 * but that redirect would drop the parameter, and the sign-in page renders
 * the failure message from it. Carry the parameter across the hop.
 *
 * A signed-in user landing on the root is just the app opening — the failed
 * sign-in is moot, so the redirect only applies without a session cookie.
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  if (url.pathname === "/" && url.searchParams.get("error") === "oidc_failed") {
    if (!request.cookies.has("kb_session")) {
      const target = new URL("/auth/sign-in", request.url);
      target.searchParams.set("error", "oidc_failed");
      return NextResponse.redirect(target);
    }
  }
  return NextResponse.next();
}

export const config = {
  // The failure redirect always lands on the origin root — nothing else needs
  // this hop, so the proxy only ever runs there.
  matcher: "/",
};
