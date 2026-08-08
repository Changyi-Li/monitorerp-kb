# HTTP Framework Choice for the `apps/api` TypeScript API — Research

**Date:** 2026-08-08 · **Design question:** which HTTP framework should the greenfield ESM TypeScript API at `apps/api` (Node >= 20, JWT-auth'd REST + multipart uploads proxied to RagFlow, future SSE proxy of RagFlow agent chat) use?

**Verdict: HONO** (served by `@hono/node-server`). Deciding factors, in order: (1) RagFlow's agent chat **is** SSE and Hono is the only candidate with first-party streaming helpers (`stream`/`streamSSE`/`pipe`, abort handling) over web-standard `Request`/`Response` — proxying an upstream SSE stream is a pass-through, not a plugin wiring exercise; (2) `@hono/zod-validator` gives per-route Zod validation with typed `c.req.valid()` — TypeScript-first by construction; (3) built-in CORS and JWT (cookie-capable) middleware; (4) `app.request()` makes vitest tests serverless. Fastify is a strong runner-up (better turnkey multipart streaming), Express 5 is the all-manual baseline, NestJS is overkill at this size.

---

## Sources & verification status

| # | Source | Identity | Used for |
|---|---|---|---|
| S1 | Local checkout `D:\src\githubs\ragflow` — `api/apps/restful_apis/agent_api.py` | v0.26.4 (per prior research note) | SSE implementation evidence |
| S2 | Same checkout — `docs/references/http_api_reference.md` | v0.26.4 | Agent chat completions endpoint docs |
| S3 | https://ragflow.io/docs/http_api_reference | live page, fetched 2026-08-08 | Online docs cross-check (OpenAI-compatible endpoint) |
| S4 | https://hono.dev/docs/getting-started/nodejs | — | Hono Node adapter, versions, Docker |
| S5 | https://hono.dev/docs/helpers/streaming | — | `stream`/`streamSSE`/`streamText`, abort, error handling |
| S6 | https://hono.dev/docs/guides/validation | — | `@hono/zod-validator`, typed `c.req.valid()` |
| S7 | https://hono.dev/docs/guides/testing | — | `app.request()` serverless testing |
| S8 | https://hono.dev/docs/middleware/builtin/cors | — | CORS options |
| S9 | https://hono.dev/docs/middleware/builtin/jwt | — | JWT middleware incl. cookie mode |
| S10 | https://hono.dev/docs/api/request | — | `parseBody`/`formData` semantics |
| S11 | https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ | — | JSON Schema validation/serialization, error shape |
| S12 | https://github.com/fastify/fastify-multipart | README | `req.file()`/`req.files()`/`req.parts()` streams, limits |
| S13 | https://github.com/fastify/sse | README (`@fastify/sse`, repo moved from `fastify-sse`) | SSE plugin: `sse: true`, `reply.sse`, lazy header commit |
| S14 | https://fastify.dev/docs/latest/Guides/Testing/ | — | `app.inject()` via light-my-request |
| S15 | https://fastify.dev/docs/v5.0.x/Guides/Migration-Guide-V5/ | — | "Fastify v5 will only support Node.js v20+" |
| S16 | https://github.com/fastify/fastify-type-provider-zod | README | Zod bridge for Fastify (Zod v4.2+) |
| S17 | https://expressjs.com/ | v5.2.1 homepage | "thin layer over Node.js"; middleware dir (multer, cors) |
| S18 | https://expressjs.com/en/5x/guide/error-handling.html | — | Async rejection auto-forwarding in Express 5 |
| S19 | https://expressjs.com/en/5x/api/response.html | — | `res` = "enhanced version of Node's own response object" |
| S20 | https://expressjs.com/en/resources/middleware/multer.html | — | Multer disk/memory storage, limits, memory warning |
| S21 | NestJS docs source (github.com/nestjs/docs.nestjs.com): `content/first-steps.md`, `techniques/validation.md`, `techniques/server-sent-events.md`, `techniques/file-upload.md` | fetched via raw.githubusercontent | NestJS architecture, ValidationPipe, `@Sse()`, FileInterceptor |
| S22 | npm registry (`registry.npmjs.org`), queried 2026-08-08 | latest versions, publish dates, `engines` | Maintenance/version snapshot, engine floors |
| S23 | https://nodejs.org/api/stream.html#streamreadablefromwebreadablestream-options and https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#duplex | — | Node web-stream interop (`Readable.fromWeb`, `duplex: "half"`) |

---

## Fact base: RagFlow agent chat streams via SSE (verified from primary sources)

Both the local v0.26.4 source/docs and the live online API reference confirm SSE:

- **Endpoint:** `POST /api/v1/agents/chat/completions` — `@manager.route("/agents/chat/completions", methods=["POST"])` (S1, `agent_api.py:1294`). Documented with body params `agent_id`, `query`, `stream` (boolean, **default `true`**), `session_id`, `inputs`, `files`, `user_id`, `return_trace` (S2, `http_api_reference.md:4670-4790`).
- **Stream format:** with `stream=true` the server emits SSE events `message`, `message_end`, `node_finished`, terminating with `[DONE]` (S2). Implementation: the handler wraps an async generator in `_build_sse_response(...)` that yields `data:<json>\n\n` frames and finishes with `data:[DONE]\n\n` (S1, `agent_api.py:1592-1614`).
- **Wire headers:** `Content-Type: text/event-stream; charset=utf-8`, `Cache-control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (S1, `_build_sse_response`, `agent_api.py:147-153`). `X-Accel-Buffering: no` matters if any nginx sits between us and the browser.
- **OpenAI-compatible twin:** `stream=true` also yields SSE in OpenAI wire format (`data:` chunks, `data: [DONE]`) — `agent_api.py:1355-1367`; online docs document `POST /api/v1/agents_openai/{agent_id}/chat/completions` with `stream` described as "Whether to receive the response as a stream" and `data:`-frame examples ending in `data: [DONE]` (S3).
- **Proxy reality:** a proxy must (a) hold the connection open and flush frames as they arrive, (b) propagate client-disconnect cancellation upstream, (c) forward/override the SSE headers. Requirement 6 is therefore a real, load-bearing streaming requirement — not a nicety.

---

## Requirements × candidates

| Requirement | Hono (+ `@hono/node-server`) | Fastify 5 | Express 5 | NestJS 11 |
|---|---|---|---|---|
| **1. Typed validated JSON REST** | First-class: `zValidator('json', z.object({...}))` from `@hono/zod-validator`; validated data via typed `c.req.valid()`; RPC type sharing for clients (S6). | JSON Schema (Ajv) validation + fast-json-stringify serialization, 400 + `validation`/`validationContext`/`code` on failure (S11). Zod via `@fastify/type-provider-zod` (requires Zod v4.2+) (S16). | None built in — "thin layer over Node.js features" (S17); bring your own (zod in middleware). | `ValidationPipe` + class-validator/class-transformer DTO decorators (S21). |
| **2. Multipart streaming (~1 GiB → RagFlow)** | No streaming multipart parser: `parseBody`/`formData` return buffered `string \| File` (S10) — proxy raw body (`c.req.raw.body` web `ReadableStream`) or parse with busboy while forwarding. Doable, manual. | Best turnkey: `@fastify/multipart` gives `req.file()`/`req.files()`/`req.parts()` as Node streams to `pipeline` onward; per-part `fileSize` limits; must consume every stream (S12). | Multer (busboy-based): `diskStorage` streams to disk; docs explicitly warn memory storage can OOM on large files; `@types/multer` needed (S20). | Multer-based `FileInterceptor` (memory/disk); not compatible with FastifyAdapter (S21). |
| **3. Auth middleware (JWT, httpOnly cookie)** | Built-in `jwt()` middleware: `secret` + `alg`, token from `Authorization` header **or cookie** (`cookie` option), typed `c.get('jwtPayload')`, `iss`/`aud`/`nbf`/`iat`/`exp` verification (S9). | Plugin: `@fastify/jwt` 10.2.1, active (S22). | Manual (`jsonwebtoken` or passport); nothing built in. | Guards + passport (`@nestjs/passport`); decorator ceremony. |
| **4. CORS** | Built-in `cors()` middleware: `origin`, `allowMethods`, `allowHeaders`, `credentials`, `maxAge`, `exposeHeaders` (S8). | `@fastify/cors` 11.3.0, active (S22). | `cors` package (official middleware dir, S17). | `app.enableCors()` on the NestFactory app (S21). |
| **5. Postgres ecosystem** | Neutral: plain TS handlers, any access layer works (pg 8.22.0, Drizzle 0.45.2, Prisma 7.9.1 — all framework-independent, S22). | Same + official `@fastify/postgres` 6.1.0 (S22). | Neutral; same drivers. | Neutral; DI encourages an injectable repository layer. |
| **6. Streaming / SSE proxy (headline)** | **First-party `hono/streaming`:** `stream`, `streamText`, `streamSSE` with `stream.writeSSE({data, event, id})`; `stream.aborted` + `stream.onAbort(cb)` for client disconnect; `stream.pipe(readable)` for pass-through (S5). Web-standard `Response` returned from handlers — a proxy can return the upstream body directly. | Official `@fastify/sse`: opt-in route (`sse: true`), `reply.sse.send()` / `reply.sse.stream()` transform, writes into `reply.raw`; lazy header commit; heartbeat; `Last-Event-ID` replay (S13). Requires **Node >= 20.20.2** (S22). | No helper: `res` "supports all built-in fields and methods" of Node's `ServerResponse` (S19) → manual `res.write()`/`flushHeaders()`. | `@Sse()` decorator; handler **must return an RxJS `Observable<MessageEvent>`**; auto-unsubscribe on client disconnect (S21). |
| **7. Ops: Docker, vitest, maintenance** | Pure JS, no native deps; docs ship a Dockerfile example (node:22-alpine) (S4). Tests via `app.request()` — no server, no supertest (S7). Hono 4.13.1 (2026-08-07), `@hono/node-server` 2.1.0 (2026-08-04) (S22). | Pure JS; tests via `app.inject()` (light-my-request), no port (S14). Fastify 5.11.3 (2026-08-08) (S22). Node 20+ (S15). | Pure JS; needs supertest-style glue against a listening server (S22: supertest 7.2.2). Express 5.2.1 (2026-07-14), Node >= 18 (S22). | Pure JS but heavy: CLI scaffolding, modules/DI/providers (S21); e2e via supertest. `@nestjs/core` 11.1.28 (2026-07-08), Node >= 20 (S21/S22). |
| **Node floor** | Node >= 18.14.1 (docs, S4); `@hono/node-server` v2 engines `>=20` (S22) — fits the app's Node >= 20. | v5: Node 20+ (S15). | Node >= 18 (S22). | Node >= 20 (S21). |

---

## Recommendation: Hono (with `@hono/node-server`)

1. **SSE is the deciding requirement, and Hono is the only candidate built around web-standard streams.** RagFlow's agent chat is confirmed SSE (see fact base). In Hono a proxy endpoint is: `fetch(ragflow, {..., signal: c.req.raw.signal})` then either return the upstream `Response`/pipe its body, or re-emit with `streamSSE` — with `onAbort`/`aborted` covering client-disconnect cancellation (S5). Fastify's `@fastify/sse` works but sits on `reply.raw` with lazy header commit and a Node 20.20.2 floor (S13, S22); Express is raw Node streams; NestJS forces an RxJS `Observable` return — awkward for piping an upstream stream (S21).
2. **TypeScript-first is the design brief, not an add-on.** `zValidator` + `c.req.valid()` gives per-route Zod validation with inference at the call site (S6). Fastify's schema story is JSON Schema + a Zod bridge with its own constraints (Zod 4.2+, `z.output` serialization semantics, S16); Express/NestJS validation is manual or decorator-based.
3. **Auth + CORS are built-in.** `jwt()` handles Bearer and cookie sources (S9) — the httpOnly-cookie session requirement is one option flag, no plugin. `cors()` covers the Next.js origin (S8).
4. **Testability:** `app.request()` in vitest needs no server and no supertest glue (S7) — matches the repo's `"test": "vitest"` script.
5. **Proportionality:** one package + one adapter, no DI/module architecture, ~no ceremony per route — right size for a small internal app. NestJS at this size is scaffolding overhead (CLI, modules, decorators, guards, RxJS for SSE) with nothing it pays for here.

**Honest trade-off vs Fastify:** Fastify wins turnkey multipart streaming (`@fastify/multipart` streams, S12) and its inject-based testing is equally serverless (S14). If upload-proxy ergonomics mattered more than SSE ergonomics, Fastify would be defensible. It loses here on (a) SSE being first-party in Hono vs a plugin with raw-reply semantics and a Node 20.20.2 floor (S13, S22), (b) two validation systems (JSON Schema + Zod bridge) instead of one, (c) JWT/CORS being plugins rather than built-ins.

**Express 5** is the baseline, not a candidate: async error forwarding is now built in (S18), but validation, multipart, CORS, auth, and SSE are all manual or third-party — every requirement above needs assembly.

**NestJS** is rejected on proportionality: for a two-endpoint-shape API (JWT REST + upload proxy + one SSE proxy), the module/DI/decorator surface and the `Observable`-mandatory SSE contract (S21) buy nothing.

---

## Gotchas for Hono in *this* app

### G1. Proxy-streaming RagFlow SSE through Hono (best practice)

Two shapes, pick per route:

- **Pure pass-through** (no transformation; recommended for the chat proxy to the Next.js frontend): wire client cancellation into the upstream fetch and hand the upstream body straight through:

  ```ts
  app.post('/api/chat/completions', async (c) => {
    const upstream = await fetch(`${RAGFLOW}/api/v1/agents/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAGFLOW_KEY}` },
      body: JSON.stringify({ agent_id, query, stream: true }),
      signal: c.req.raw.signal,          // client disconnect aborts the upstream fetch
    });
    if (!upstream.ok) return c.json(await upstream.json(), upstream.status as any);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',       // RagFlow sets this itself (S1, agent_api.py:151) — keep it if any nginx is in front
        'Connection': 'keep-alive',
      },
    });
  });
  ```

  No buffering, no re-encoding, backpressure handled by the streams. RagFlow events are `message` / `message_end` / `node_finished`, terminated by `data:[DONE]` (S2) — forward verbatim; EventSource in the browser consumes them as-is.

- **Transform/re-emit** (e.g., you want OpenAI-style chunks for a chat UI): use `streamSSE` and write frames with `stream.writeSSE({ data, event, id })`; check `stream.aborted` in the loop and call `abortController.abort()` on the upstream fetch from `stream.onAbort(cb)` (S5).

Known helper quirk: if the streaming callback throws, Hono's global `onError` hook does **not** fire — errors go to the helper's optional third-arg handler (or console) (S5). Wire that handler to abort the upstream fetch, and keep the upstream fetch's abort controller in scope.

### G2. Multipart (up to ~1 GiB) → RagFlow without buffering

- `c.req.parseBody()` / `c.req.formData()` materialize files as buffered `File` objects (S10) — do **not** use them for ~1 GiB documents.
- **No-field-inspection fast path** (if the route forwards everything): proxy the raw body with a `duplex: "half"` fetch, converting the web stream to a Node stream:

  ```ts
  const nodeBody = Readable.fromWeb(c.req.raw.body as any);   // web → Node (S23)
  const upstream = await fetch(`${RAGFLOW}/api/v1/datasets/${id}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': c.req.header('content-type')!, Authorization: `Bearer ${KEY}` },
    body: nodeBody,
    duplex: 'half',                                            // required for Node stream bodies (S23)
  });
  ```

- **Field-aware path** (the app's shape: RagFlow upload needs the multipart fields/files, and the proxy may need to add its own key or dataset id): parse with `busboy` (1.6.0, S22) directly off the converted Node stream and forward file parts + fields onward as they arrive — memory stays flat regardless of file size. This is also the escape hatch if RagFlow must receive the file before the API answers (store-and-forward to disk via `pipeline(part, createWriteStream(...))`, then upload).
- RagFlow's per-request cap is 1 GiB (`MAX_CONTENT_LENGTH` default, from the prior research note F section) — the proxy should enforce the same `fileSize` limit itself to fail fast.

### G3. Vitest integration

- Unit/integration tests need no server: build a `Request` and call `app.request(path, init)`; assert on the returned web `Response` (`res.status`, `res.json()`, `res.text()`); pass env bindings as the third argument (S7). This is plain vitest — no supertest.
- For streaming routes in tests, consume `res.body` (a web `ReadableStream`) with `getReader()`; assert on decoded chunks, and test client-disconnect by calling `reader.cancel()` and asserting the upstream abort fired.
- Keep the Hono app in a factory (`export const createApp = () => new Hono()`) so tests and `src/index.ts` (`serve(createApp())` from `@hono/node-server`, S4) share one construction path.
- If you want a real-socket e2e: `serve({ fetch: app.fetch, port: 0 })` and use `fetch` against the returned address.

### G4. Node 20 / ESM quirks

- `@hono/node-server` v2 declares `engines.node >= 20` (S22) — the app's `>= 20` floor is fine, but pin the Docker image to a concrete LTS (docs example uses `node:22-alpine`, S4) so `>=20` never drifts to an untested 20.0.x.
- Repo already uses `"type": "module"` + `tsc` build: with `module: "nodenext"`/`"node16"` every relative import needs an explicit `.js` extension in emitted ESM (standard TS rule — the scaffold's `tsc` build will enforce this; `tsx` dev tolerates extensionless imports, which masks it until `npm run build`).
- Node stream interop goes both ways: `Readable.fromWeb()` for web→Node (upload parsing), and fetch with a Node stream body requires `duplex: "half"` (S23).
- Don't accumulate upstream chunks in an array anywhere in the SSE path — use `stream.pipe()` (S5); `streamSSE` + Node's HTTP/1.1 response handle backpressure. Note `hono/streaming`'s helpers return web `Response`s, which `@hono/node-server` serves directly.

---

## Version / maintenance snapshot (npm registry, 2026-08-08, S22)

| Package | Latest | Last publish | Engines (latest) |
|---|---|---|---|
| hono | 4.13.1 | 2026-08-07 | node >= 16.9.0 |
| @hono/node-server | 2.1.0 | 2026-08-04 | node >= 20 |
| @hono/zod-validator | 0.9.0 | 2026-07-15 | — |
| fastify | 5.11.3 | 2026-08-08 | — (docs: v5 = Node 20+, S15) |
| @fastify/multipart | 10.1.0 | 2026-08-06 | — |
| @fastify/sse | 0.6.0 | 2026-07-27 | node >= 20.20.2 |
| @fastify/jwt | 10.2.1 | 2026-08-06 | — |
| @fastify/cors | 11.3.0 | 2026-08-06 | — |
| @fastify/postgres | 6.1.0 | 2026-08-06 | — |
| express | 5.2.1 | 2026-07-14 | node >= 18 |
| multer | 2.2.0 | 2026-06-15 | node >= 10.16.0 |
| @nestjs/core | 11.1.28 | 2026-07-08 | node >= 20 |

All four candidates are actively maintained; Hono and Fastify are the most release-active. All are pure JS (no mandatory native deps), Docker-friendly.
