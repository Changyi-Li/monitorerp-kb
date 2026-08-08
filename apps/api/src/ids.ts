const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when the value is a well-formed uuid — guards id params before DB queries. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
