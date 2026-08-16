// Drizzle wraps driver errors as { query, params, cause }; the Postgres
// SQLSTATE lives on the cause.
export function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause
  return cause?.code === '23505'
}
