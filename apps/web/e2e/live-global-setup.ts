import { loadLiveEnv } from './live-env'

/**
 * Stage (b) preflight (ticket #37): fail loudly — never a silent skip — when
 * the four RagFlow env vars are missing or the instance is unreachable, then
 * wipe the test dataset so leftovers from a crashed run can't poison
 * assertions or stale retrieval. Runs once before the suite; a throw here
 * reddens the whole stage with a clear message.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** An upstream failure carrying its HTTP status (undefined for network). */
class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** One retry on infrastructure-style failures (network, 5xx) before red —
 * never on 4xx, which is a misconfiguration (bad key, wrong dataset). */
async function withInfraRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : undefined
    if (typeof status === 'number' && status < 500) throw err
    console.warn(`[gate] ${label}: transient upstream failure (${(err as Error).message}); retrying once`)
    await sleep(1500)
    return await fn()
  }
}

export default async function globalSetup(): Promise<void> {
  const env = loadLiveEnv()
  const authHeader = `Bearer ${env.ragflowApiKey}`
  const documentsUrl = `${env.ragflowUrl.replace(/\/+$/, '')}/api/v1/datasets/${env.ragflowDatasetId}/documents`

  console.log(`[gate] stage (b): full-stack e2e against the live RagFlow at ${env.ragflowUrl}`)

  // Reachability + preflight wipe: the list call doubles as the reachability
  // probe — an unreachable instance, a bad key, or an unknown dataset throws
  // here and the stage fails loudly before any test runs.
  const listed = await withInfraRetry('preflight list', async () => {
    let res: Response
    try {
      res = await fetch(documentsUrl, { headers: { authorization: authHeader } })
    } catch (err) {
      throw new Error(`preflight list: RagFlow unreachable — ${(err as Error).message}`)
    }
    if (res.status >= 500 || !res.ok) throw new UpstreamError(`preflight list: RagFlow answered HTTP ${res.status}`, res.status)
    return (await res.json()) as { code?: number; data?: { docs?: Array<{ id?: string }> } }
  })
  if (listed.code !== 0) {
    throw new Error(
      `preflight list was rejected (code ${String(listed.code)}) — ` +
        `check RAGFLOW_DATASET_ID points at the dedicated test dataset`,
    )
  }
  const ids = (listed.data?.docs ?? []).filter((doc) => doc.id !== undefined).map((doc) => doc.id as string)
  if (ids.length > 0) {
    const deleted = await withInfraRetry('preflight wipe', async () => {
      let res: Response
      try {
        res = await fetch(documentsUrl, {
          method: 'DELETE',
          headers: { authorization: authHeader, 'content-type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
      } catch (err) {
        throw new Error(`preflight wipe: RagFlow unreachable — ${(err as Error).message}`)
      }
      if (res.status >= 500 || !res.ok) throw new UpstreamError(`preflight wipe: RagFlow answered HTTP ${res.status}`, res.status)
      return (await res.json()) as { code?: number }
    })
    if (deleted.code !== 0) {
      throw new Error(
        `preflight wipe was rejected (code ${String(deleted.code)}) — leftover documents remain in the test dataset`,
      )
    }
  }
  console.log('[gate] preflight wipe complete — test dataset is empty')
}
