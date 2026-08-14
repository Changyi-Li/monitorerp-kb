# MonitorERP KB — Web

Next.js 16 client for the MonitorERP KB document manager. The browser talks
to `/api/*` on this origin; `next.config.ts` proxies it to the Hono API
(production nginx does the same).

## Development

```bash
# 1. Postgres (from the repo root) and the API
docker compose up -d
cd ../api && npm install && npm run dev   # API on :4801

# 2. This app
npm install
npm run dev                                # web on :4800
```

The dataset display name in the sidebar is derived at runtime: the shell
layout (server-side) fetches `/dataset` from the API, which reads the name
from the configured RagFlow dataset (issue #40). Nothing is baked into the
client bundle at build time.

## End-to-end tests (Playwright)

Full-stack journeys against the real web app + real API + the RagFlow stub
— no live RagFlow is involved. Playwright starts all three servers itself
(API with a dedicated `monitorerp_kb_e2e` database on the compose Postgres,
created and reset automatically).

```bash
npx playwright install chromium   # once
npm run test:e2e
```

Journeys cover: sign-up → activate → sign-in; upload → publish →
published → withdraw → draft; retry → exhausted → withdraw → re-publish;
super admin publishing another member's draft document; users
administration with the last-admin guard; pending/deactivated sign-in
refusal; theme persistence with the locked dark primary; empty states
with a clear-filters action; and reduced-motion disabling animations.

## Release gate: full-stack e2e against the real RagFlow (stage b)

`npm run gate:e2e` (stage (b) of spec #28; own Playwright config
`playwright.live.config.ts` — the daily `playwright.config.ts` and
`npm run test:e2e` are untouched) drives the full stack against the **real**
RagFlow instance: publish → real parse → `published` with `chunk_count > 0`;
a chat stream completes with a non-empty answer whose terminal reference
carries at least one chunk mapped to the published Document; session history
round-trips; session and document deletion work. Assertions verify the
pipeline only — never the model's wording, citation markers in the answer
text, or parse timing.

Same manual prerequisites and env contract as the API's gate stages (see
`../api/readme.md`, "Release gate"): a dedicated test dataset and test agent
in the RagFlow UI, and the four RagFlow env vars set. `npm run gate` from
the API directory runs all three gate stages in order; this is its stage (b).
The stage preflight-wipes the test dataset, boots a fresh API against a
truncated e2e
database (it never reuses a stale stub-backed API), retries each test once
on infrastructure failures, and fails loudly when misconfigured. Stop the
daily e2e stack first — both configurations own ports 4800/4801.

```bash
RAGFLOW_URL=... RAGFLOW_API_KEY=... RAGFLOW_DATASET_ID=... RAGFLOW_AGENT_ID=... npm run gate:e2e
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Next dev server on :4800 |
| `npm run build` / `npm start` | production build / serve |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright end-to-end suite (against the RagFlow stub) |
| `npm run gate:e2e` | Stage (b) of the release gate — full-stack e2e against the real RagFlow instance (see above) |
