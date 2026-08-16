import { loadOidcLiveEnv } from './oidc-live-env'

/**
 * The live OIDC gate's preflight (spec #57 / issue #62): fail loudly — never
 * a silent skip — when the Keycloak instance is unreachable or the admin
 * credentials are wrong, then ensure the gate's e2e user exists in the
 * `monitorerp` realm with a known password. The committed realm artifact
 * (keycloak/monitorerp-realm.json) deliberately holds no users, so the gate
 * creates its own via the admin REST API. Runs once before the suite; a
 * throw here reddens the whole gate with a clear message.
 */

/** One retry on infrastructure-style failures (network, 5xx) before red. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[gate] ${label}: transient failure (${(err as Error).message}); retrying once`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return await fn()
  }
}

export default async function globalSetup(): Promise<void> {
  const env = loadOidcLiveEnv()
  const realm = 'monitorerp'
  const base = env.adminBaseUrl
  console.log(`[gate] OIDC round trip against the Keycloak at ${base} (realm ${realm})`)

  // Admin token from the master realm (the admin-cli client is built in).
  const token = await withRetry('admin token', async () => {
    let res: Response
    try {
      res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: env.adminUser,
          password: env.adminPassword,
        }),
      })
    } catch (err) {
      throw new Error(`Keycloak unreachable — is the dev instance running? (${(err as Error).message})`)
    }
    if (res.status === 401 || res.status === 400) {
      throw new Error(`Keycloak admin login refused (HTTP ${res.status}) — check KEYCLOAK_ADMIN_USER/PASSWORD`)
    }
    if (!res.ok) throw new Error(`Keycloak admin token failed with HTTP ${res.status}`)
    const body = (await res.json()) as { access_token?: unknown }
    if (typeof body.access_token !== 'string') throw new Error('Keycloak admin token response carried no access_token')
    return body.access_token
  })
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // The full profile Keycloak's default realm profile requires on login
  // (first/last name are mandatory — a user without them is forced through
  // the "Update Account Information" page, which would stall the gate).
  const userRepresentation = {
    username: env.e2eUser,
    email: env.e2eUser,
    emailVerified: true,
    enabled: true,
    firstName: 'OIDC',
    lastName: 'E2E',
  }

  // Find the e2e user; create it when missing.
  const lookup = async (): Promise<Array<{ id: string }>> => {
    const res = await fetch(`${base}/admin/realms/${realm}/users?username=${encodeURIComponent(env.e2eUser)}`, {
      headers: auth,
    })
    if (!res.ok) throw new Error(`Keycloak user lookup failed with HTTP ${res.status}`)
    return (await res.json()) as Array<{ id: string }>
  }
  let users = await lookup()
  if (users.length === 0) {
    const created = await fetch(`${base}/admin/realms/${realm}/users`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(userRepresentation),
    })
    if (!created.ok) throw new Error(`creating the Keycloak e2e user failed with HTTP ${created.status}`)
    users = await lookup()
    if (users.length === 0) throw new Error('the Keycloak e2e user was created but the lookup still finds nothing')
  }

  // Bring an existing user up to the full profile too — a user created by an
  // older run without the names would otherwise hit the profile page.
  const updated = await fetch(`${base}/admin/realms/${realm}/users/${users[0].id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify(userRepresentation),
  })
  if (!updated.ok) throw new Error(`updating the Keycloak e2e user failed with HTTP ${updated.status}`)

  // Reset the password on every run: idempotent, and a stale password from a
  // previous run can never block the gate.
  const reset = await fetch(`${base}/admin/realms/${realm}/users/${users[0].id}/reset-password`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ type: 'password', value: env.e2ePassword, temporary: false }),
  })
  if (!reset.ok) throw new Error(`resetting the Keycloak e2e user's password failed with HTTP ${reset.status}`)
  console.log(`[gate] e2e user ${env.e2eUser} ensured in the ${realm} realm`)
}
