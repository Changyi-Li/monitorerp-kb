import { Hono, type Context } from 'hono'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'

/**
 * OIDC sign-in (Keycloak) contract under /auth (issue #58, spec #57).
 *
 * The capability endpoint reports the feature state to the web: disabled
 * when no OIDC_* variables are configured, enabled with the login URL
 * otherwise. The flow endpoints (login, callback) are inert — the same 404
 * an unregistered route answers — until the sign-in flow lands (issue #61),
 * and stay inert when OIDC is disabled, so an unconfigured deployment
 * behaves exactly as before OIDC existed.
 */
export function oidcRoutes(deps: Deps): Hono {
  const app = new Hono()
  const oidc = deps.config.oidc

  app.get('/config', (c) => {
    if (oidc === null) return c.json({ enabled: false })
    return c.json({ enabled: true, loginUrl: oidc.loginUrl })
  })

  // Inert until the authorization-code flow is implemented (issue #61).
  const inert = (c: Context): Response => sendError(c, 404, 'not_found', 'Not found')
  app.get('/login', inert)
  app.get('/callback', inert)

  return app
}
