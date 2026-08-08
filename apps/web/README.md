# MonitorERP KB — Web

Next.js 16 client for the MonitorERP KB document manager. The browser talks
to `/api/*` on this origin; `next.config.ts` proxies it to the Hono API
(production nginx does the same).

## Development

```bash
# 1. Postgres (from the repo root) and the API
docker compose up -d
cd ../api && npm install && npm run dev   # API on :3001

# 2. This app
npm install
npm run dev                                # web on :3000
```

The dataset display name is config-driven via `NEXT_PUBLIC_DATASET_NAME`
(default `monitorerp-china-internal`).

## End-to-end tests (Playwright)

Full-stack journeys against the real web app + real API + the RagFlow stub
— no live RagFlow is involved. Playwright starts all three servers itself
(API with a dedicated `monitorerp_kb_e2e` database on the compose Postgres,
created and reset automatically).

```bash
npx playwright install chromium   # once
npm run test:e2e
```

Journeys cover: sign-up → activate → sign-in; upload → mark-ready →
publish → published → withdraw → draft; retry → exhausted → withdraw →
re-promote → re-publish; super admin publishing another member's ready
document; users administration with the last-admin guard; pending/
deactivated sign-in refusal; theme persistence with the locked dark
primary; empty states with a clear-filters action; and reduced-motion
disabling animations.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next dev server on :3000 |
| `npm run build` / `npm start` | production build / serve |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright end-to-end suite |
