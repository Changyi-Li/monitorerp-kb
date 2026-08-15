/** OIDC sign-in configuration — present only when all four OIDC_* variables are set. */
export interface OidcConfig {
  /** The issuer base; the discovery document is fetched from it. */
  issuerUrl: string
  clientId: string
  clientSecret: string
  /** The browser-facing callback URL (the realm's registered redirect URI). */
  redirectUri: string
  /** The browser-facing login URL the web's sign-in button links to. */
  loginUrl: string
}

export interface Config {
  databaseUrl: string
  jwtSecret: string
  adminEmail: string
  adminPassword: string
  adminName: string
  ragflowUrl: string
  ragflowApiKey: string
  ragflowDatasetId: string
  ragflowAgentId: string
  pollIntervalMs: number
  port: number
  /** OIDC sign-in (Keycloak) — null when disabled (no OIDC_* variables set). */
  oidc: OidcConfig | null
}

// The OIDC endpoints' fixed paths under /auth (the realm's registered
// redirect URIs end with the callback path).
const OIDC_CALLBACK_PATH = '/auth/oidc/callback'
const OIDC_LOGIN_PATH = '/auth/oidc/login'

/** The four OIDC environment variables, all-or-nothing (the public contract). */
export const OIDC_VARIABLES = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const

/**
 * All-or-nothing: the four OIDC variables must be set together or not at all.
 * A partial configuration is a boot-time error — it can never half-enable
 * the feature. With none set, OIDC is disabled.
 */
function loadOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const set = OIDC_VARIABLES.filter((name) => env[name])
  if (set.length === 0) return null
  if (set.length < OIDC_VARIABLES.length) {
    const missing = OIDC_VARIABLES.filter((name) => !env[name])
    throw new Error(
      `OIDC is partially configured: ${OIDC_VARIABLES.join(', ')} must be set all together or not at all (missing: ${missing.join(', ')})`,
    )
  }
  const redirectUri = env['OIDC_REDIRECT_URI'] as string
  if (!redirectUri.endsWith(OIDC_CALLBACK_PATH)) {
    throw new Error(`OIDC_REDIRECT_URI must end with ${OIDC_CALLBACK_PATH} (the browser-facing callback path), got ${redirectUri}`)
  }
  return {
    issuerUrl: env['OIDC_ISSUER_URL'] as string,
    clientId: env['OIDC_CLIENT_ID'] as string,
    clientSecret: env['OIDC_CLIENT_SECRET'] as string,
    redirectUri,
    loginUrl: redirectUri.slice(0, -OIDC_CALLBACK_PATH.length) + OIDC_LOGIN_PATH,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`Missing required environment variable ${name}`)
    return value
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    adminEmail: required('ADMIN_EMAIL'),
    adminPassword: required('ADMIN_PASSWORD'),
    adminName: env['ADMIN_NAME'] ?? 'Super Admin',
    ragflowUrl: required('RAGFLOW_URL'),
    ragflowApiKey: required('RAGFLOW_API_KEY'),
    ragflowDatasetId: required('RAGFLOW_DATASET_ID'),
    ragflowAgentId: required('RAGFLOW_AGENT_ID'),
    pollIntervalMs: env['POLL_INTERVAL_MS'] ? Number(env['POLL_INTERVAL_MS']) : 5000,
    port: env['PORT'] ? Number(env['PORT']) : 4801,
    oidc: loadOidcConfig(env),
  }
}
