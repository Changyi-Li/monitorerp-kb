export interface Config {
  databaseUrl: string
  jwtSecret: string
  adminEmail: string
  adminPassword: string
  adminName: string
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
    port: env['PORT'] ? Number(env['PORT']) : 3001,
  }
}
