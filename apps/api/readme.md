# MonitorERP KB — API

Hono API for the MonitorERP KB document manager (Node 20 ESM + Postgres via Drizzle).

## Development

```bash
# 1. Start Postgres (from the repo root)
docker compose up -d

# 2. Install and run
npm install
npm run dev          # tsx watch, defaults to :3001
```

The first boot applies committed migrations and, when the `users` table is
empty, seeds the super admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` /
`ADMIN_NAME` (logged once). Configuration comes from `.env` (dev values
committed) or the process environment (deployments).

A single-replica in-process sweeper polls RagFlow on `POLL_INTERVAL_MS` and
reconciles every `publishing` document's status (run state → published /
failed / progress). Multi-replica deployments would need a distributed lock
or outbox — explicitly out of scope for v1.

### Env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (dev database) |
| `TEST_DATABASE_URL` | Postgres connection string used by the test suite |
| `JWT_SECRET` | HS256 key for session tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | First-boot super admin seed |
| `RAGFLOW_URL` / `RAGFLOW_API_KEY` / `RAGFLOW_DATASET_ID` / `RAGFLOW_AGENT_ID` | RagFlow connection (file store); dataset and agent ids from the RagFlow UI |
| `POLL_INTERVAL_MS` | Sweeper poll interval (default 5000) — reconciles publishing documents with RagFlow's parse state |
| `PORT` | HTTP port (default 3001) |

## Tests

The test suite drives the app's HTTP surface (`app.request()` under vitest)
against a real Postgres database on the same compose server — it creates
`monitorerp_kb_test` on first run, applies the committed migrations, and
truncates between tests.

```bash
npm test             # vitest run
npm run typecheck    # tsc over src + tests
```

## Release gate: live RagFlow suites (stages c and a+)

The release gate's live suites (spec #28) run against the **real** RagFlow
instance via one shared live vitest configuration (`vitest.live.config.ts`,
opt-in and env-gated), one stage per script:

- `npm run gate:revalidation` — stage (c): audits the RagFlow **stub's**
  scripted wire expectations against the real wire — direct HTTP probes for
  upload, list, parse trigger (stopped at `RUNNING`, never waited out),
  delete, session get/delete, and one completion stream.
- `npm run gate:contract` — stage (a+): drives the app's real RagFlow client
  and agent client against the live instance — upload, list, download
  (byte-for-byte), chunk-method flip, parse trigger, delete, session
  fetch/delete, and the error surfaces (`code != 0` rejections map to
  `RagflowError`). A real parse runs to `DONE` with `chunk_count > 0` (short
  poll, multi-minute timeout), and a real completion stream is piped through
  the app's chat transform (think-tag stripping, event normalization,
  citation→Document mapping against the live reference shape).

The shared expectations module `test/ragflow-wire.ts` encodes the
version-verified shapes in its documented expectations table and records the
RagFlow version validated (`RAGFLOW_VERSION_VALIDATED`); bump the constant
and note the new version in the table after a successful run against a newer
RagFlow.

**Manual prerequisites** (one-time, in the RagFlow UI): a dedicated **test
dataset** (embedder + chunk method configured) and a dedicated **test agent**
(retrieval node + model) on the existing deployment — never the production
collection. Point the gate at them with the same env vars the API reads:

| Variable | For the gate |
|---|---|
| `RAGFLOW_URL` | The existing RagFlow deployment |
| `RAGFLOW_API_KEY` | Its API key (stays server-side) |
| `RAGFLOW_DATASET_ID` | The dedicated test dataset |
| `RAGFLOW_AGENT_ID` | The dedicated test agent |

```bash
RAGFLOW_URL=... RAGFLOW_API_KEY=... RAGFLOW_DATASET_ID=... RAGFLOW_AGENT_ID=... npm run gate:revalidation
```

Each stage fails loudly — never a silent skip — when the env vars are missing
or the instance is unreachable. Both preflight-wipe the test dataset (deletes
every document), retry infrastructure-style failures once before going red,
and clean up after themselves on a best-effort basis. The daily suite
(`npm test`) and its configuration are untouched.

## Schema changes

```bash
npm run db:generate  # drizzle-kit generate — commits a new SQL migration
```

Then re-run the tests; the test database is migrated automatically.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch src/index.ts` |
| `npm test` | vitest run |
| `npm run typecheck` | `tsc --noEmit` (src + tests) |
| `npm run build` / `npm start` | compile with `tsc` and serve `dist/` |
| `npm run db:generate` | drizzle-kit generate |
| `npm run gate:revalidation` | Stage (c) of the release gate — audits the stub's wire expectations against the real RagFlow instance (see above) |
| `npm run gate:contract` | Stage (a+) of the release gate — drives the app's real RagFlow/agent clients against the live instance (see above) |
