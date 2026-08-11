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
  }
}
