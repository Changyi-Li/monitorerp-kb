import { expect, test } from '@playwright/test'
import {
  activateUser,
  ADMIN,
  apiSignUp,
  deactivateUser,
  promoteUser,
  rowAction,
  setStubRun,
  signIn,
  signOut,
  signUp,
  uniqueEmail,
  uploadFile,
} from './helpers'

test.describe('account journeys', () => {
  test('sign-up → activate → sign-in', async ({ page }) => {
    const email = uniqueEmail('alice')
    await signUp(page, 'Alice', email, 'password123')
    await expect(page.getByText('Account created')).toBeVisible()
    await expect(page.getByText(/awaiting activation/i)).toBeVisible()

    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Users' }).click()
    const row = page.locator('tbody tr', { hasText: email })
    await expect(row.getByText('Pending')).toBeVisible()
    await row.getByRole('button', { name: 'Activate' }).click()
    await expect(row.getByText('Active')).toBeVisible()

    await signOut(page)
    await signIn(page, email, 'password123')
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible()
  })

  test('pending sign-in is refused with a 403 and the activation message', async ({ page, request }) => {
    const email = uniqueEmail('pending')
    await apiSignUp(request, email)
    const apiRes = await request.post('/api/auth/sign-in', { data: { email, password: 'password123' } })
    expect(apiRes.status()).toBe(403)
    await signIn(page, email, 'password123')
    // Scoped to the form: Next's route announcer also carries role="alert".
    await expect(page.locator('form').getByRole('alert')).toContainText('awaiting activation')
  })

  test('a deactivated user is blocked from signing in', async ({ page, request }) => {
    const email = uniqueEmail('gone')
    await apiSignUp(request, email)
    await activateUser(request, email)
    await deactivateUser(request, email)
    const apiRes = await request.post('/api/auth/sign-in', { data: { email, password: 'password123' } })
    expect(apiRes.status()).toBe(403)
    await signIn(page, email, 'password123')
    await expect(page.locator('form').getByRole('alert')).toContainText('deactivated')
  })
})

test.describe('document journeys', () => {
  test('upload → mark-ready → publish → published → withdraw → draft', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    const row = await uploadFile(page, 'notes.md', '# notes\n')
    await rowAction(page, row, 'Mark ready')
    await expect(row.getByText('Ready')).toBeVisible()
    await rowAction(page, row, 'Publish')
    await expect(row.getByText('Publishing')).toBeVisible()

    await setStubRun('notes.md', 'DONE', { chunk_count: 4 })
    await expect(row.getByText('Published')).toBeVisible()

    await rowAction(page, row, 'Withdraw')
    await expect(row.getByText('Draft')).toBeVisible()
  })

  test('retry → exhausted → withdraw → re-promote → re-publish', async ({ page, request }) => {
    await signIn(page, ADMIN.email, ADMIN.password)
    const row = await uploadFile(page, 'broken.md', '# broken\n')
    await rowAction(page, row, 'Mark ready')
    await rowAction(page, row, 'Publish')
    await expect(row.getByText('Publishing')).toBeVisible()

    await setStubRun('broken.md', 'FAIL', { progress_msg: 'parser crashed' })
    await expect(row.getByText('Failed')).toBeVisible()

    // Detail panel: failed alert with retries-left and the error text.
    await row.click()
    const panel = page.locator('aside').last()
    await expect(panel.getByRole('alert')).toContainText('3 retries left')
    await expect(panel.getByRole('alert')).toContainText('parser crashed')

    // Two retries: each moves to publishing, then fails again with one fewer
    // retry left (the alert reappears after the sweeper settles it).
    for (const retriesLeft of [2, 1]) {
      await panel.getByRole('button', { name: 'Retry' }).click()
      await setStubRun('broken.md', 'FAIL')
      const label = retriesLeft === 1 ? '1 retry left' : `${retriesLeft} retries left`
      await expect(panel.getByRole('alert')).toContainText(label)
    }

    // A third retry consumes the last one.
    await panel.getByRole('button', { name: 'Retry' }).click()
    await setStubRun('broken.md', 'FAIL')
    await expect(panel.getByRole('alert')).toContainText(/no retries left/i)

    // The next retry is refused outright: the document stays failed with zero
    // retries left (a successful retry would hide the alert entirely).
    await panel.getByRole('button', { name: 'Retry' }).click()
    await expect(panel.getByRole('alert')).toContainText(/no retries left/i)
    const adminSignIn = await request.post('/api/auth/sign-in', { data: ADMIN })
    expect(adminSignIn.status()).toBe(200)
    const list = await (await request.get('/api/documents?q=broken.md')).json()
    const detail = await (await request.get(`/api/documents/${list.items[0].id}`)).json()
    expect(detail.document.status).toBe('failed')
    expect(detail.document.retries_left).toBe(0)

    // Withdraw → re-promote → re-publish completes.
    await panel.getByRole('button', { name: 'Withdraw' }).click()
    await expect(panel.getByText('Draft')).toBeVisible()
    await panel.getByRole('button', { name: 'Close details' }).click()
    await rowAction(page, row, 'Mark ready')
    await expect(row.getByText('Ready')).toBeVisible()
    await rowAction(page, row, 'Publish')
    await setStubRun('broken.md', 'DONE', { chunk_count: 7 })
    await expect(row.getByText('Published')).toBeVisible()
  })

  test('a super admin publishes another member\'s ready document', async ({ page, request }) => {
    const email = uniqueEmail('member')
    await apiSignUp(request, email)
    await activateUser(request, email)

    await signIn(page, email, 'password123')
    const row = await uploadFile(page, 'shared.md', '# shared\n')
    await rowAction(page, row, 'Mark ready')
    await expect(row.getByText('Ready')).toBeVisible()

    await signOut(page)
    await signIn(page, ADMIN.email, ADMIN.password)
    const adminRow = page.locator('tbody tr', { hasText: 'shared.md' })
    await rowAction(page, adminRow, 'Publish')
    await expect(adminRow.getByText('Publishing')).toBeVisible()
  })
})

test.describe('users administration', () => {
  test('pending-activation count, per-row actions, and the last-admin guard', async ({ page, request }) => {
    await apiSignUp(request, uniqueEmail('waiting'))
    await signIn(page, ADMIN.email, ADMIN.password)
    await page.getByRole('link', { name: 'Users' }).click()

    // Pending-activation count badge.
    await expect(page.getByText(/pending activation/)).toBeVisible()

    // The last active super admin is guarded: badge + disabled actions.
    const adminRow = page.locator('tbody tr', { hasText: ADMIN.email })
    await expect(adminRow.getByText('Last super admin')).toBeVisible()
    await expect(adminRow.getByRole('button', { name: 'Demote to member' })).toBeDisabled()
    await expect(adminRow.getByRole('button', { name: 'Deactivate' })).toBeDisabled()

    // A second super admin lifts the guard.
    const second = uniqueEmail('second')
    await apiSignUp(request, second)
    await activateUser(request, second)
    await promoteUser(request, second)
    await page.reload()
    const guardedRow = page.locator('tbody tr', { hasText: ADMIN.email })
    await expect(guardedRow.getByText('Last super admin')).not.toBeVisible()
    await expect(guardedRow.getByRole('button', { name: 'Demote to member' })).toBeEnabled()

    // A member cannot see the Users screen at all.
    await signOut(page)
    await signIn(page, second, 'password123')
    await expect(page.getByRole('link', { name: 'Users' })).not.toBeVisible()
  })
})
