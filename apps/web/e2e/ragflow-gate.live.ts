import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { ADMIN, rowAction, signIn } from './helpers'

// Stage (b) of the RagFlow release gate (spec #28 / ticket #37): the web app
// against the real API and the REAL RagFlow instance. Assertions verify the
// pipeline, never the model — publish → real parse → published with chunks; a
// chat stream completes with a non-empty answer whose terminal reference
// carries at least one chunk mapped to the published Document; session
// history round-trips; session and document deletion work. Never the model's
// wording, citation markers in the answer text, or parse timing.
//
// Runs via `npm run gate:e2e` (own Playwright config); the daily e2e and its
// configuration are untouched. The probe document uses the stub's canonical
// reference name, so this spec is also exercisable against the RagFlow stub
// (whose scripted citations map to that name, issue #25); on the real
// instance the name is inert — citations carry the uploaded document's real
// id.
//
// Every test looks up its target through the API (newest session, document
// by name) instead of carrying module state: a timed-out test restarts the
// worker, and the API is the source of truth anyway.

const PROBE_NAME = 'Leave Policy.md'
const PROBE_CONTENT = `# Leave Policy

The leave policy grants 21 days of annual leave per calendar year.
It resets every January 1st.`

// Real parsing takes minutes and a real model stream takes a minute or two —
// every per-parse and per-stream wait is generous (spec #28, user story 13).
const PARSE_TIMEOUT_MS = 240_000
const STREAM_TIMEOUT_MS = 180_000

async function adminApi(request: APIRequestContext): Promise<APIRequestContext> {
  const res = await request.post('/api/auth/sign-in', { data: ADMIN })
  if (res.status() !== 200) throw new Error(`admin sign-in failed with ${res.status()}`)
  return request
}

interface SessionSummary {
  id: string
  title: string
}

/** The newest chat session — this run's chat test created it, and nothing
 * since has; retries' sessions are older, so the newest is always ours. */
async function newestSession(request: APIRequestContext): Promise<SessionSummary> {
  const res = await request.get('/api/chat/sessions?page_size=100')
  if (res.status() !== 200) throw new Error(`session list failed with ${res.status()}`)
  const list = (await res.json()) as { items: SessionSummary[] }
  const newest = list.items[0]
  if (newest === undefined) throw new Error('no chat sessions found')
  return newest
}

/** Uploads the probe document and returns the NEWEST matching row — the list
 * is newest-first, so retries' and earlier runs' duplicates stay older. */
async function uploadProbe(page: Page): Promise<Locator> {
  await page.locator('input[type="file"]').setInputFiles({
    name: PROBE_NAME,
    mimeType: 'text/plain',
    buffer: Buffer.from(PROBE_CONTENT),
  })
  const row = page.locator('tbody tr', { hasText: PROBE_NAME }).first()
  await expect(row.getByText('Draft')).toBeVisible()
  return row
}

test.describe('stage (b): full-stack e2e against the real RagFlow instance', () => {
  test.afterAll(async () => {
    // Best-effort cleanup of what THIS run created — a cleanup failure never
    // reddens the stage (spec #28; orphaned sessions are tolerated).
    const base = 'http://localhost:4800'
    try {
      const signInRes = await fetch(`${base}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ADMIN),
      })
      const cookie = signInRes.headers.get('set-cookie')?.split(';')[0] ?? ''
      const headers = { cookie }
      // Leftover probe documents (a retried publish may have created extras;
      // the next run's preflight wipe covers RagFlow's side).
      const docs = await (await fetch(`${base}/api/documents?q=${encodeURIComponent(PROBE_NAME)}`, { headers })).json()
      for (const doc of docs.items as Array<{ id: string }>) {
        await fetch(`${base}/api/documents/${doc.id}`, { method: 'DELETE', headers })
      }
      // Leftover chat sessions.
      const sessions = await (await fetch(`${base}/api/chat/sessions?page_size=100`, { headers })).json()
      for (const session of sessions.items as Array<{ id: string }>) {
        await fetch(`${base}/api/chat/sessions/${session.id}`, { method: 'DELETE', headers })
      }
    } catch (err) {
      console.warn(`[gate] cleanup failed — ${(err as Error).message}`)
    }
  })

  test('publish → real parse → published with chunk_count > 0', async ({ page, request }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    const row = await uploadProbe(page)
    await rowAction(page, row, 'Publish')
    await expect(row.getByText('Publishing')).toBeVisible()

    // The real parser and embedder run to completion on their own — the API
    // sweeper reconciles the run state, so no stub control is involved.
    await expect(row.getByText('Published')).toBeVisible({ timeout: PARSE_TIMEOUT_MS })

    // Pipeline proof at the API: published with real chunks.
    await adminApi(request)
    const list = await (await request.get(`/api/documents?q=${encodeURIComponent(PROBE_NAME)}`)).json()
    const document = list.items[0] as { id: string; status: string; chunk_count: number }
    expect(document.status).toBe('published')
    expect(document.chunk_count).toBeGreaterThan(0)
  })

  test('a chat stream completes: non-empty answer, terminal reference with a chunk mapped to our Document', async ({
    page,
    request,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await expect(page).toHaveURL(/\/chat(\?.*)?$/)

    // The session title is the query, capped at 48 chars by titleFromMessage
    // — stay under the cap so the sidebar row and delete button match later.
    // Minted per invocation so a retried run never collides with its own
    // earlier session.
    const query = `Leave days per year? (gate ${Date.now()})`
    const composer = page.getByLabel('Message', { exact: true })
    await composer.fill(query)
    await page.getByRole('button', { name: 'Send message' }).click()

    // The answer renders non-empty, then the stream ends (the composer
    // re-enables once filled).
    const answer = page.locator('div.text-sm.leading-relaxed').first()
    await expect(answer).not.toHaveText('', { timeout: STREAM_TIMEOUT_MS })
    await composer.fill(query)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()

    // The lazy session was created: the URL is pinned to it.
    await expect(page).toHaveURL(/\/chat\?s=/)
    const sessionId = new URL(page.url()).searchParams.get('s')
    if (sessionId === null) throw new Error('the lazy session URL was not pinned')

    // The terminal reference, via the app's own history API: the stored
    // message_end reference normalized with at least one chunk — and the
    // citation→Document mapping: the wiped test dataset holds only our probe
    // document, so retrieval must cite it and the mapping must resolve to our
    // Document (document_id non-null).
    await adminApi(request)
    const messages = await (await request.get(`/api/chat/sessions/${sessionId}/messages`)).json()
    const assistant = (messages.items as Array<{
      role: string
      references?: Array<{ document_id: string | null }>
    }>).find((m) => m.role === 'assistant')
    expect(assistant?.references?.length ?? 0).toBeGreaterThan(0)
    // The wiped test dataset holds only our probe document, so retrieval must
    // cite it — and the citation→Document mapping must resolve to our
    // Document (document_id non-null, via documents.ragflow_document_id).
    // Never asserted: the document NAME, which the pipeline does not control.
    const mapped = assistant?.references?.find((r) => r.document_id !== null)
    expect(mapped).toBeDefined()
  })

  test('session history round-trips against the real agent', async ({ page, request }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await expect(page).toHaveURL(/\/chat(\?.*)?$/)
    await adminApi(request)
    const { id, title } = await newestSession(request)

    // Reload with the pinned ?s= URL: the thread renders from live history —
    // the user question (scoped to the bubble, not the sidebar title) and the
    // assistant's stored answer.
    await page.goto(`/chat?s=${id}`)
    await expect(page.locator('div.bg-primary', { hasText: title })).toBeVisible({ timeout: STREAM_TIMEOUT_MS })
    await expect(page.locator('div.text-sm.leading-relaxed').first()).not.toHaveText('')
  })

  test('deleting a session removes it from the app and the live agent', async ({ page, request }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await expect(page).toHaveURL(/\/chat(\?.*)?$/)
    await adminApi(request)
    const { id, title } = await newestSession(request)

    const sidebar = page.locator('aside').last()
    const row = sidebar.locator('li', { hasText: title })
    const confirmRow = sidebar.locator('li', { hasText: 'Delete this chat?' })
    await row.getByRole('button', { name: `Delete ${title}` }).click()
    await expect(confirmRow).toBeVisible()
    await confirmRow.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(row).not.toBeVisible()
    await page.reload()
    await expect(sidebar.getByText(title)).not.toBeVisible()

    // The route deletes the RagFlow session first, then our row: the history
    // now 404s, proving both sides.
    const res = await request.get(`/api/chat/sessions/${id}/messages`)
    expect(res.status()).toBe(404)
  })

  test('deleting the published document removes it from the app and RagFlow', async ({ page, request }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await adminApi(request)

    // The newest probe-named Document is ours (leftovers are older).
    const list = await (await request.get(`/api/documents?q=${encodeURIComponent(PROBE_NAME)}`)).json()
    const document = list.items[0] as { id: string }
    expect(typeof document.id).toBe('string')

    // Delete every probe-named row via the UI (a retried publish may have
    // left extras), then prove our Document is gone at the API. The row must
    // be VISIBLE before counting — an early count races the post-sign-in
    // navigation, sees an empty table, and passes toHaveCount(0) vacuously
    // without deleting anything.
    const rows = page.locator('tbody tr', { hasText: PROBE_NAME })
    await expect(rows.first()).toBeVisible()
    for (let i = 0; i < (await rows.count()); i += 1) {
      await rowAction(page, rows.first(), 'Delete')
      await expect(rows.first()).not.toBeVisible()
    }
    await expect(rows).toHaveCount(0)

    const res = await request.get(`/api/documents/${document.id}`)
    expect(res.status()).toBe(404)
  })
})
