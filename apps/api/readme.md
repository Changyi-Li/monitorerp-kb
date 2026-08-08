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

### Env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (dev database) |
| `TEST_DATABASE_URL` | Postgres connection string used by the test suite |
| `JWT_SECRET` | HS256 key for session tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | First-boot super admin seed |
| `RAGFLOW_URL` / `RAGFLOW_API_KEY` / `RAGFLOW_DATASET_ID` | RagFlow connection (file store); dataset id from the RagFlow UI |
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
