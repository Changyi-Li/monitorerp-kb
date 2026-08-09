import { expect, test } from '@playwright/test'
import { activateUser, ADMIN, apiSignUp, rowAction, signIn, signOut, uploadFile, uniqueEmail } from './helpers'

// issue #16: a non-owner member must see download-only actions on another
// user's document (spec #6, story #31). The regression this guards: the
// client cached the signed-in user across a client-side account switch, so
// the member's UI was computed with the previous session's (admin) identity.
test.describe('document permissions', () => {
test('non-owner member sees download-only actions on another user\'s document', async ({ page, request }) => {
  // Unique name so the row lookup is unambiguous (prior e2e runs leave
  // duplicate notes.md rows in the shared e2e database).
  const docName = `permissions-${Date.now()}.md`

  // 1. As super admin: upload a document and mark it ready.
  await signIn(page, ADMIN.email, ADMIN.password)
  const row = await uploadFile(page, docName, '# notes\n')
  await rowAction(page, row, 'Mark ready')
  await expect(row.getByText('Ready')).toBeVisible()

  // 2. Create + activate a member who owns nothing.
  const email = uniqueEmail('member')
  await apiSignUp(request, email)
  await activateUser(request, email)

  // 3. Switch accounts WITHOUT a page load. signOut navigates via
  // router.replace, and the form below is filled in place, so the JS bundle
  // (and its module-level caches) survives — the real user flow. A
  // page.goto() here would reload the bundle and mask the issue #16 bug.
  await signOut(page)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/')

  // Sanity: the session really is the member's — the sidebar badge comes
  // from the app's own fresh /api/auth/me fetch.
  await expect(page.getByText('Member', { exact: true })).toBeVisible()

  // 4. The admin's ready document has no "⋯" menu for the member.
  const adminRow = page.locator('tbody tr', { hasText: docName })
  await expect(adminRow).toBeVisible()
  await expect(adminRow.getByRole('button', { name: 'Document actions' })).toHaveCount(0)

  // 5. The detail panel offers Download only — no Publish, no Delete.
  await adminRow.click()
  const panel = page.locator('aside').last()
  await expect(panel.getByRole('link', { name: 'Download' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Publish' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0)
})
})
