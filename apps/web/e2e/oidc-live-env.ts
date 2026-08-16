// Environment contract for the live OIDC gate (spec #57; issues #62, #63). The
// gate drives the real round trip against the development Keycloak — the
// same four OIDC_* variables the API needs. When any is missing it fails
// loudly with a clear message instead of silently skipping (the same
// philosophy as the live RagFlow gate, ticket #37). The Keycloak admin
// credentials and the e2e user default to the documented dev instance
// (docs/keycloak-provisioning.md) and are overridable.

export const OIDC_LIVE_VARS = [
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
] as const

/**
 * The e2e user's Keycloak profile — the source of the `name` claim (spec
 * #57). The global setup fixes these names in the realm on every run, and
 * after sign-in the app shell renders the display name derived from them:
 * both sides read this one constant so a rename cannot silently drift
 * (issue #63).
 */
export const E2E_USER_PROFILE = { firstName: 'OIDC', lastName: 'E2E' } as const

export interface OidcLiveEnv {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** The Keycloak admin REST base — the issuer URL's origin. */
  adminBaseUrl: string
  adminUser: string
  adminPassword: string
  /** The Keycloak user the gate signs in as (ensured by the global setup). */
  e2eUser: string
  e2ePassword: string
  /** The display name the shell renders after sign-in — the profile's first
   * + last name, exactly what the ID token's `name` claim carries. */
  e2eUserName: string
}

export function loadOidcLiveEnv(env: NodeJS.ProcessEnv = process.env): OidcLiveEnv {
  const missing = OIDC_LIVE_VARS.filter((name) => (env[name] ?? '') === '')
  if (missing.length > 0) {
    throw new Error(
      `The live OIDC gate is missing ${missing.join(', ')}. ` +
        `It drives the real round trip against the development Keycloak — start the ` +
        `Keycloak container, import the monitorerp realm, and set the four OIDC_* ` +
        `variables (see docs/keycloak-provisioning.md).`,
    )
  }
  // The guard above guarantees every variable is non-empty.
  const value = (name: (typeof OIDC_LIVE_VARS)[number]): string => env[name] ?? ''
  const issuerUrl = value('OIDC_ISSUER_URL')
  return {
    issuerUrl,
    clientId: value('OIDC_CLIENT_ID'),
    clientSecret: value('OIDC_CLIENT_SECRET'),
    redirectUri: value('OIDC_REDIRECT_URI'),
    // The admin console and the realm live on the issuer's origin
    // (http://127.0.0.1:8081 in development).
    adminBaseUrl: new URL(issuerUrl).origin,
    adminUser: env['KEYCLOAK_ADMIN_USER'] ?? 'admin',
    adminPassword: env['KEYCLOAK_ADMIN_PASSWORD'] ?? 'admin',
    e2eUser: env['OIDC_E2E_USER'] ?? 'oidc-e2e@monitorerp.local',
    e2ePassword: env['OIDC_E2E_PASSWORD'] ?? 'oidc-e2e-password',
    e2eUserName: `${E2E_USER_PROFILE.firstName} ${E2E_USER_PROFILE.lastName}`,
  }
}
