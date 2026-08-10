import { expect, test } from '@playwright/test'
import { activateUser, ADMIN, apiSignUp, signIn, uniqueEmail } from './helpers'

const STUB_URL = 'http://127.0.0.1:9399'

/** The stub's scripted answer, streamed in word-level deltas. */
const ANSWER = 'Leave is capped at 21 days per year. It resets every calendar year.'

// Unique per run: the e2e database and the stub's request log persist across
// runs when a dev reuses running servers (playwright's reuseExistingServer),
// so fixed queries would collide with entries from earlier runs.
const RUN_TAG = `${Date.now()}`
const Q1 = `Leave days ${RUN_TAG}`
const Q2 = `Arrivals ${RUN_TAG}`
const Q3 = `Withdraw ${RUN_TAG}`

interface StoredCompletion {
  agentId: string
  sessionId: string | null
  query: string
  streamedSessionId: string
}

/** The completion requests the stub has served (shared across all specs). */
async function stubCompletions(): Promise<StoredCompletion[]> {
  const res = await fetch(`${STUB_URL}/__test/completions`)
  expect(res.status).toBe(200)
  return (await res.json()) as StoredCompletion[]
}

test.describe('chat', () => {
  test('new chat streams the answer token by token and the session appears in the sidebar', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    // A regex, not a glob: this Playwright version's globs do not match a
    // single-segment path like /chat.
    await expect(page).toHaveURL(/\/chat(\?.*)?$/)

    // Empty state on a pristine stack (servers booted by this run). When a
    // dev reuses running servers, earlier runs' sessions may already be
    // listed — the completion log records whether the stack is fresh.
    const pre = await stubCompletions()
    if (pre.length === 0) {
      await expect(page.getByText('No chats yet.')).toBeVisible()
    }
    await expect(page.getByText('Ask about the knowledge base')).toBeVisible()

    const composer = page.getByLabel('Message', { exact: true })
    const sendButton = page.getByRole('button', { name: 'Send message' })
    await composer.fill(Q1)
    await sendButton.click()

    // The composer is disabled while the answer streams (the stub streams in
    // word-level deltas over ~300 ms, so the window is observable).
    await expect(sendButton).toBeDisabled()

    // The answer renders incrementally, then in full.
    await expect(page.getByText('Leave is capped', { exact: false })).toBeVisible()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // The stream ended: the composer accepts the next message (the send
    // button is disabled only while streaming or while the input is empty).
    await composer.fill(Q3)
    await expect(sendButton).toBeEnabled()

    // The lazy session was created: the URL is pinned and the sidebar lists
    // it titled from the first message (the shell's nav aside comes first).
    const sidebar = page.locator('aside').last()
    await expect(page).toHaveURL(/\/chat\?s=/)
    await expect(sidebar.getByText(Q1)).toBeVisible()

    // The stub saw exactly one completion, sent without a session id (lazy).
    const completions = await stubCompletions()
    const mine = completions.filter((c) => c.query === Q1)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.sessionId).toBeNull()

    // Reloading lists the session from the server, most recently updated first.
    await page.reload()
    await expect(page.locator('aside').last().getByText(Q1)).toBeVisible()
  })

  test('a follow-up message reuses the session and moves it to the top of the sidebar', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()

    const composer = page.getByLabel('Message', { exact: true })
    const sendButton = page.getByRole('button', { name: 'Send message' })
    await composer.fill(Q2)
    await sendButton.click()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // Second question in the same session. The answer text is identical to
    // the first, so the second send is validated by the bubble COUNT, which
    // only grows once the second stream rendered.
    await composer.fill(Q3)
    await sendButton.click()
    await expect(page.getByText(ANSWER, { exact: false })).toHaveCount(2)

    // The proxy sent the RagFlow session id for the follow-up — the stub
    // records it once the request lands.
    const arrivals = await stubCompletions()
    const first = arrivals.find((c) => c.query === Q2)
    const second = arrivals.find((c) => c.query === Q3)
    expect(first).toBeDefined()
    expect(second?.sessionId).toBe(first?.streamedSessionId)
  })

  test('the Chat nav item is visible to members too', async ({ page, request }) => {
    const email = uniqueEmail('chatmember')
    await apiSignUp(request, email)
    await activateUser(request, email)
    await signIn(page, email, 'password123')
    await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible()
  })
})
