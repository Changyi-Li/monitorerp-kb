import { expect, test } from '@playwright/test'
import { loadOidcLiveEnv } from './oidc-live-env'

/**
 * The live OIDC gate (spec #57; issues #62, #63): the real round trip against
 * the development Keycloak — the sign-in page renders the Keycloak button
 * (the capability endpoint reports enabled), clicking it lands on the Keycloak
 * login page (the realm is in the URL), signing in lands on the app signed in
 * AS the e2e user (the API provisions the User as an active Member), and
 * signing out then clicking again re-enters WITHOUT a password (user story 9
 * — the Keycloak session outlives the local app session).
 *
 * Runs via `npm run gate:oidc` (own Playwright config); the daily e2e and
 * its configuration are untouched (the `.live.ts` suffix keeps this spec out
 * of the daily glob).
 */

const env = loadOidcLiveEnv()

test.describe('stage: OIDC sign-in round trip against the development Keycloak', () => {
  test('the button appears, starts the Keycloak round trip, and signs the user in', async ({ page }) => {
    await page.goto('/auth/sign-in')

    // Acceptance: with OIDC enabled the button appears, and clicking it
    // starts the OIDC sign-in.
    const keycloakButton = page.getByRole('link', { name: 'Sign in with Keycloak', exact: true })
    await expect(keycloakButton).toBeVisible()
    await keycloakButton.click()

    // The Keycloak login page, realm in the URL (the API owns the redirect;
    // the flow cookie rides along). Exact labels: the password field's
    // "Show password" toggle also carries a "password"-ish accessible name.
    await page.waitForURL(/\/realms\/monitorerp\/protocol\/openid-connect\/auth/)
    await page.getByLabel('Username or email', { exact: true }).fill(env.e2eUser)
    await page.getByLabel('Password', { exact: true }).fill(env.e2ePassword)
    await page.getByRole('button', { name: /sign in/i }).click()

    // Signed in: the app shell renders (the API provisioned the User —
    // active Member, no activation step) — and the current user IS the e2e
    // user the global setup ensured: the shell shows the display name
    // derived from the shared e2e-user profile (env.e2eUserName) with the
    // Member role badge, and the session's API identity is the e2e user's
    // email (issue #63 acceptance).
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible()
    await expect(page.getByText(env.e2eUserName, { exact: true })).toBeVisible()
    await expect(page.getByText('Member', { exact: true })).toBeVisible()
    const meRes = await page.request.get('/api/auth/me')
    if (meRes.status() !== 200) {
      throw new Error(`/api/auth/me after OIDC sign-in failed with HTTP ${meRes.status()}`)
    }
    const me = (await meRes.json()) as { user: { email: string } }
    expect(me.user.email).toBe(env.e2eUser)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

    // Signing out clears the APP session only; the Keycloak session survives
    // (spec #57). Clicking the button again therefore re-enters without a
    // password — Keycloak redirects straight back (user story 9).
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL('**/auth/sign-in')
    await page.getByRole('link', { name: 'Sign in with Keycloak', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible({ timeout: 60_000 })
  })
})
