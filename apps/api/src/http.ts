/** Parses a `Cookie` header into name → value pairs. */
export function parseCookies(header: string): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name) continue
    let decoded = value
    try {
      decoded = decodeURIComponent(value)
    } catch {
      // Malformed percent-encoding — keep the raw value; downstream
      // verification rejects it (401), not a 500.
    }
    cookies.set(name, decoded)
  }
  return cookies
}
