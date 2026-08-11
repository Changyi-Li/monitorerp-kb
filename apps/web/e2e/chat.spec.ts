import { expect, test } from '@playwright/test'
import { activateUser, ADMIN, apiSignUp, signIn, uniqueEmail, uploadFile } from './helpers'

const STUB_URL = 'http://127.0.0.1:9399'

/**
 * The stub's scripted answer, streamed in word-level deltas. Its [ID:n]
 * markers are rewritten to [n] by the API transform (issue #30) and render
 * as chips whose text is just the number, so the rendered text has no
 * brackets.
 */
const ANSWER = 'Leave is capped at 21 days per year 19. It resets every calendar year 41.'

// The stub's scripted reasoning, streamed between start_to_think/end_to_think.
const REASONING = 'The user asks about the leave policy. The policy states 21 days per year.'

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

  test('citation chips reveal source cards; Open full document only for managed Documents', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    // The managed Document: the stub assigns 'Leave Policy.md' the fixed id
    // its scripted citation [ID:19] references, so this upload maps to the card.
    await uploadFile(page, 'Leave Policy.md', '# Leave policy\n')

    await page.getByRole('link', { name: 'Chat' }).click()
    await page.waitForURL(/\/chat(\?.*)?$/)

    const composer = page.getByLabel('Message', { exact: true })
    await composer.fill(`Cite ${RUN_TAG}`)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // Both [n] markers render as clickable chips (rewritten from [ID:n]).
    const chip1 = page.getByRole('button', { name: 'Source 19: Leave Policy.md' })
    const chip2 = page.getByRole('button', { name: 'Source 41: External Handbook.pdf' })
    await expect(chip1).toBeVisible()
    await expect(chip2).toBeVisible()

    // Clicking [19] reveals the managed source's card: passage, page, name.
    await chip1.click()
    await expect(page.getByText('Leave is capped at 21 days per year.', { exact: false })).toBeVisible()
    await expect(page.getByText('Leave Policy.md')).toBeVisible()
    await expect(page.getByText('page 3')).toBeVisible()
    const openLink = page.getByRole('link', { name: 'Open full document' })
    await expect(openLink).toBeVisible()

    // Clicking the same chip again collapses the card.
    await chip1.click()
    await expect(page.getByText('Leave Policy.md')).not.toBeVisible()
    await expect(page.getByText('page 3')).not.toBeVisible()
    await expect(openLink).not.toBeVisible()

    // Clicking [41] swaps to the external source: no page, no link.
    await chip2.click()
    await expect(page.getByText('It resets every calendar year.', { exact: false })).toBeVisible()
    await expect(page.getByText('External Handbook.pdf')).toBeVisible()
    await expect(page.getByText('page 3')).not.toBeVisible()
    await expect(page.getByRole('link', { name: 'Open full document' })).not.toBeVisible()

    // Clicking [19] again swaps back to the managed source.
    await chip1.click()
    await expect(openLink).toBeVisible()

    // The link goes to that Document's detail.
    await openLink.click()
    await expect(page).toHaveURL(/\/\?doc=/)
    const panel = page.locator('aside').last()
    await expect(panel.getByText('Leave Policy.md')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Close details' })).toBeVisible()
  })

  test('Show thinking toggles the collapsible reasoning pane', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await page.waitForURL(/\/chat(\?.*)?$/)

    const composer = page.getByLabel('Message', { exact: true })
    await composer.fill(`Reasoning ${RUN_TAG}`)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // The reasoning pane is collapsed by default: its content is not rendered.
    await expect(page.getByText(REASONING, { exact: false })).not.toBeVisible()

    const toggle = page.getByRole('button', { name: 'Show thinking' })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByText(REASONING, { exact: false })).toBeVisible()

    // Toggling again collapses it.
    await page.getByRole('button', { name: 'Hide thinking' }).click()
    await expect(page.getByText(REASONING, { exact: false })).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Show thinking' })).toBeVisible()
  })

  test('reasoning streams to the thinking pane before the answer completes (#33)', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await page.waitForURL(/\/chat(\?.*)?$/)

    const composer = page.getByLabel('Message', { exact: true })
    await composer.fill(Q1)
    await page.getByRole('button', { name: 'Send message' }).click()

    // The "Show thinking" toggle appears as soon as the FIRST reasoning delta
    // reaches the browser. Issue #33's dev rewrite-proxy buffering held the
    // whole SSE until completion, so the toggle would appear together with the
    // full answer at the end. Observing the toggle here while the full answer
    // is NOT yet rendered proves the stream is live (the streaming Route
    // Handler, not the buffering rewrite).
    const showThinking = page.getByRole('button', { name: 'Show thinking' })
    await expect(showThinking).toBeVisible()
    await expect(page.getByText(ANSWER, { exact: false })).not.toBeVisible()

    // The reasoning is present mid-stream; expand it, then the answer finishes.
    await showThinking.click()
    await expect(page.getByText(REASONING, { exact: false })).toBeVisible()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()
  })

  test('resuming a past session renders its full thread with citations', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    // The managed Document so the history citation links to it (issue #25).
    await uploadFile(page, 'Leave Policy.md', '# Leave policy\n')

    await page.getByRole('link', { name: 'Chat' }).click()
    await page.waitForURL(/\/chat(\?.*)?$/)
    const composer = page.getByLabel('Message', { exact: true })
    const query = `Resume ${RUN_TAG}`
    await composer.fill(query)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // Reload: the pinned ?s= URL deep-links straight into the history.
    await page.reload()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    // Clicking the session in the sidebar re-renders the full thread from
    // history — the user question, the answer, the reasoning toggle, and the
    // citation chips.
    const sidebar = page.locator('aside').last()
    await expect(sidebar.getByText(query)).toBeVisible()
    await sidebar.getByText(query).click()

    await expect(page.locator('div.bg-primary', { hasText: query })).toBeVisible()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show thinking' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Source 19: Leave Policy.md' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Source 41: External Handbook.pdf' })).toBeVisible()

    // History citations link to managed Documents exactly as live ones do.
    await page.getByRole('button', { name: 'Source 19: Leave Policy.md' }).click()
    await expect(page.getByRole('link', { name: 'Open full document' })).toBeVisible()
    await page.getByRole('button', { name: 'Source 41: External Handbook.pdf' }).click()
    await expect(page.getByRole('link', { name: 'Open full document' })).not.toBeVisible()
  })

  test('deleting a session removes it from the sidebar after confirm', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Chat' }).click()
    await page.waitForURL(/\/chat(\?.*)?$/)

    const composer = page.getByLabel('Message', { exact: true })
    const query = `Doomed ${RUN_TAG}`
    await composer.fill(query)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(ANSWER, { exact: false })).toBeVisible()

    const sidebar = page.locator('aside').last()
    const row = sidebar.locator('li', { hasText: query })
    // The confirm step replaces the row's content (and its title text), so
    // the confirming row is found by its prompt instead.
    const confirmRow = sidebar.locator('li', { hasText: 'Delete this chat?' })

    // Cancel first: nothing is deleted.
    await row.getByRole('button', { name: `Delete ${query}` }).click()
    await expect(confirmRow).toBeVisible()
    await confirmRow.getByRole('button', { name: 'Cancel delete' }).click()
    await expect(sidebar.getByText(query)).toBeVisible()

    // Confirm: the session leaves the sidebar and stays gone on reload.
    await row.getByRole('button', { name: `Delete ${query}` }).click()
    await confirmRow.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(sidebar.getByText(query)).not.toBeVisible()
    await page.reload()
    await expect(sidebar.getByText(query)).not.toBeVisible()
  })

  test('the Chat nav item is visible to members too', async ({ page, request }) => {
    const email = uniqueEmail('chatmember')
    await apiSignUp(request, email)
    await activateUser(request, email)
    await signIn(page, email, 'password123')
    await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible()
  })
})
