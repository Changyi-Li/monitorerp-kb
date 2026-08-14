# MonitorERP KB — API

Hono API for the MonitorERP KB document manager (Node 20 ESM + Postgres via Drizzle).

## Development

```bash
# 1. Start Postgres (from the repo root)
docker compose up -d

# 2. Install and run
npm install
npm run dev          # tsx watch, defaults to :4801
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
| `PORT` | HTTP port (default 4801) |

## Tests

The test suite drives the app's HTTP surface (`app.request()` under vitest)
against a real Postgres database on the same compose server — it creates
`monitorerp_kb_test` on first run, applies the committed migrations, and
truncates between tests.

```bash
npm test             # vitest run
npm run typecheck    # tsc over src + tests
```

## Release gate (spec #28)

The release gate validates the app against the **real** RagFlow instance,
in three stages — **stub revalidation → contract tests → full-stack e2e** —
so a wire-level problem is diagnosed before the slower stages run:

- **Stage (c) — stub revalidation** (`npm run gate:revalidation`): audits the
  RagFlow **stub's** scripted wire expectations against the real wire —
  direct HTTP probes for upload, list, parse trigger (stopped at `RUNNING`,
  never waited out), delete, dataset GET (the shell's display name, #40),
  session get/delete, and one completion stream.
- **Stage (a+) — contract tests** (`npm run gate:contract`): drives the app's
  real RagFlow client and agent client against the live instance — upload,
  list, download (byte-for-byte), chunk-method flip, parse trigger, dataset
  fetch, delete, session fetch/delete, and the error surfaces (`code != 0`
  rejections map to `RagflowError`). A real parse runs to `DONE` with
  `chunk_count > 0` (short
  poll, multi-minute timeout), and a real completion stream is piped through
  the app's chat transform (think-tag stripping, event normalization,
  citation→Document mapping against the live reference shape).
- **Stage (b) — full-stack e2e** (`npm --prefix ../web run gate:e2e`): the web
  app against the real API and real RagFlow (full assertion list in
  `../web/README.md`, "Release gate").

**One headless command runs all three in order**, stopping at the first red
stage; each stage also runs on its own, so a failed stage or a single
diagnostic can be re-run without the whole gate (bash syntax — set the
variables however your shell or CI does):

```bash
RAGFLOW_URL=... RAGFLOW_API_KEY=... RAGFLOW_DATASET_ID=... RAGFLOW_AGENT_ID=... npm run gate
```

Runnable on their own (e.g. re-run stage (c) on demand after a RagFlow
config or version change):

```bash
npm run gate:revalidation          # stage (c)
npm run gate:contract              # stage (a+)
npm --prefix ../web run gate:e2e   # stage (b)
```

The shared expectations module `test/ragflow-wire.ts` encodes the
version-verified shapes in its documented expectations table and records the
RagFlow version validated (`RAGFLOW_VERSION_VALIDATED`); bump the constant
and note the new version in the table after a successful run against a newer
RagFlow.

### Environment contract

The gate reads the same four environment variables as the API:

| Variable | What it points at |
|---|---|
| `RAGFLOW_URL` | The existing RagFlow deployment's base URL (e.g. `http://ragflow.internal:9380`) |
| `RAGFLOW_API_KEY` | Its API key — server-side only, never committed |
| `RAGFLOW_DATASET_ID` | The dedicated TEST dataset's id (RagFlow UI → Datasets → the dataset's id) |
| `RAGFLOW_AGENT_ID` | The dedicated TEST agent's id (RagFlow UI → Agents → the agent's id) |

**One-time manual setup** (a few minutes, in the RagFlow UI — never the
production collection):

1. **Test dataset** — create a new dataset and, in its settings, configure an
   **embedder** (embedding model) and a **chunk method** (e.g. Naive) —
   parsing needs both.
2. **Test agent** — create a new agent, add a **Retrieval** node pointing at
   the test dataset, and select the **model** in the agent's settings.
3. Copy the dataset and agent ids from their pages into the variables above.

The gate is CI-ready by construction: one headless command, no manual steps
beyond the one-time setup, loud failure with guidance when misconfigured
(missing vars or an unreachable instance red the first stage — never a
silent skip), and no new infrastructure — the existing compose Postgres and
the real RagFlow instance. Every stage preflight-wipes the test dataset
(deletes every document), retries infrastructure-style failures once before
going red, and cleans up after itself on a best-effort basis. The daily
suites (`npm test` here; `npm run test:e2e` in the web app) and their
configurations are untouched.

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
| `npm run gate` | The whole release gate — revalidation → contract → full-stack e2e, stopping at the first red stage (see above) |
