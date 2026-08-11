import type { NextRequest } from 'next/server'

// Streams the chat-completion SSE through a Route Handler instead of the
// next.config rewrite. The rewrite proxies /api/* in `next dev`, and that
// proxy BUFFERS the whole response body until the upstream connection closes
// — so the browser saw nothing until the answer completed (issue #33). A
// Route Handler returns its response body as a Web ReadableStream, which
// `next dev` forwards chunk by chunk. (Production nginx proxies /api/*
// directly and does not buffer text/event-stream, so this handler is
// dev-effective — but it is correct in any deployment that routes /api/*
// through Next.) The catch-all rewrite is kept for the non-streaming routes.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3001'

export async function POST(req: NextRequest): Promise<Response> {
  // Intentionally a narrow allowlist, not a full proxy: this endpoint needs
  // only the session cookie (auth is cookie-based) and the JSON content-type.
  // A future header this endpoint requires must be forwarded here explicitly.
  const upstream = await fetch(`${API_ORIGIN}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: req.headers.get('cookie') ?? '',
    },
    body: await req.text(),
  })
  // Stream the upstream BODY verbatim — passing its ReadableStream lets Next
  // forward bytes to the browser as they arrive, instead of buffering (the
  // fix for #33). The response HEADERS are a curated set (the SSE contract
  // needs only content-type + cache-control), not a full copy of upstream's.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}
