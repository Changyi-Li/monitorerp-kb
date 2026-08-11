import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4801";

const nextConfig: NextConfig = {
  // Same-origin API: the browser talks to /api/* and this proxies to the Hono
  // app, stripping the /api prefix (production nginx does the same job, per the
  // deployment decision — the Hono app's routes are /auth/*, /documents/*, …).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
