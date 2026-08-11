import {
  agentCompletionsUrl,
  agentSessionsUrl,
  completionRequestBody,
  datasetChunksUrl,
  datasetDocumentsUrl,
  deleteDocumentsBody,
  parseTriggerBody,
  sessionDeleteBody,
  sessionFetchParams,
} from '../ragflow-wire.js'
import { loadLiveEnv } from './env.js'

/**
 * Raw HTTP probes against the LIVE RagFlow instance (stage (c) of the release
 * gate, ticket #35). Every request is built from the shared wire-expectations
 * module (ragflow-wire.ts), so the audit cannot drift from the stub's
 * scripted shapes. The stage's one retry applies to infrastructure-style
 * failures only — network errors, 5xx, unparseable payloads; protocol-level
 * surprises (4xx, envelope mismatches) surface immediately, because the gate
 * is allowed to red on those.
 */

export class LiveUpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

const liveEnv = loadLiveEnv()

const authHeader = `Bearer ${liveEnv.ragflowApiKey}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isInfraFailure = (err: LiveUpstreamError): boolean => err.status === undefined || err.status >= 500

/** One retry on infrastructure-style failures before the stage goes red —
 * never on protocol errors or shape mismatches. */
export async function withInfraRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof LiveUpstreamError) || !isInfraFailure(err)) throw err
    console.warn(`[revalidation] ${label}: transient upstream failure (${err.message}); retrying once`)
    await sleep(1500)
    return await fn()
  }
}

export interface ProbeResult {
  status: number
  payload: Record<string, unknown>
}

/** Throws LiveUpstreamError unless the response is 2xx — 5xx is retried as
 * infrastructure, 4xx is a misconfiguration or a protocol change. */
const classifyUpstream = (label: string, res: Response): void => {
  if (res.status >= 500) {
    throw new LiveUpstreamError(`${label}: RagFlow answered HTTP ${res.status}`, res.status)
  }
  if (!res.ok) {
    throw new LiveUpstreamError(`${label}: RagFlow answered HTTP ${res.status}`, res.status)
  }
}

/** Fetches a JSON endpoint. Non-zero `code` envelopes (RagFlow's HTTP-200
 * rejections) are NOT thrown here — they are returned as payloads for the
 * suite to assert, exactly as the expectations table documents them. */
const request = (label: string, url: string, init: RequestInit): Promise<ProbeResult> =>
  withInfraRetry(label, async () => {
    let res: Response
    try {
      res = await fetch(url, { ...init, headers: { authorization: authHeader, ...init.headers } })
    } catch (err) {
      // Network-level failure (DNS, refused connection): infrastructure.
      throw new LiveUpstreamError(`${label}: RagFlow unreachable — ${(err as Error).message}`)
    }
    classifyUpstream(label, res)
    try {
      return { status: res.status, payload: (await res.json()) as Record<string, unknown> }
    } catch {
      // An unparseable body (HTML proxy page, empty body) reads as unreachable.
      throw new LiveUpstreamError(`${label}: RagFlow returned an unparseable payload (HTTP ${res.status})`)
    }
  })

export const uploadDocument = (name: string, content: string): Promise<ProbeResult> => {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  return request('upload document', datasetDocumentsUrl(liveEnv.ragflowUrl, liveEnv.ragflowDatasetId), {
    method: 'POST',
    body: form,
  })
}

export const listDocuments = (): Promise<ProbeResult> =>
  request('list documents', datasetDocumentsUrl(liveEnv.ragflowUrl, liveEnv.ragflowDatasetId), { method: 'GET' })

export const triggerParse = (documentIds: string[]): Promise<ProbeResult> =>
  request('parse trigger', datasetChunksUrl(liveEnv.ragflowUrl, liveEnv.ragflowDatasetId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parseTriggerBody(documentIds)),
  })

export const deleteDocuments = (ids: string[]): Promise<ProbeResult> =>
  request('delete documents', datasetDocumentsUrl(liveEnv.ragflowUrl, liveEnv.ragflowDatasetId), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deleteDocumentsBody(ids)),
  })

export const fetchSession = (sessionId: string): Promise<ProbeResult> => {
  const url = new URL(agentSessionsUrl(liveEnv.ragflowUrl, liveEnv.ragflowAgentId))
  for (const [key, value] of Object.entries(sessionFetchParams(sessionId))) {
    url.searchParams.set(key, value)
  }
  return request('session fetch', url.toString(), { method: 'GET' })
}

export const deleteSession = (sessionId: string): Promise<ProbeResult> =>
  request('session delete', agentSessionsUrl(liveEnv.ragflowUrl, liveEnv.ragflowAgentId), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sessionDeleteBody(sessionId)),
  })

/** The docs array of a list payload, or [] for a malformed one. */
export const listDocsOf = (payload: Record<string, unknown>): Array<{ id?: string; run?: string }> => {
  const data = payload['data'] as { docs?: Array<{ id?: string; run?: string }> } | undefined
  return data?.docs ?? []
}

export interface CompletionProbeResult {
  status: number
  headers: Headers
  body: string
}

/** Runs one full agent completion stream to `[DONE]`. The retry wraps the
 * WHOLE stream — a mid-body reset is infrastructure too; the retried run
 * auto-creates a fresh session, which post-run cleanup tolerates. */
export const completionStream = (query: string): Promise<CompletionProbeResult> =>
  withInfraRetry('completion stream', async () => {
    let res: Response
    try {
      res = await fetch(agentCompletionsUrl(liveEnv.ragflowUrl), {
        method: 'POST',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        body: JSON.stringify(completionRequestBody(liveEnv.ragflowAgentId, query)),
      })
    } catch (err) {
      throw new LiveUpstreamError(`completion stream: RagFlow unreachable — ${(err as Error).message}`)
    }
    classifyUpstream('completion stream', res)
    let body: string
    try {
      body = await res.text()
    } catch (err) {
      throw new LiveUpstreamError(`completion stream: stream reset mid-body — ${(err as Error).message}`)
    }
    return { status: res.status, headers: res.headers, body }
  })

/**
 * Preflight wipe (spec #28, user story 17): lists the test dataset and
 * deletes every document, so leftovers from a crashed run can't poison
 * assertions or stale retrieval. Doubles as the reachability probe — an
 * unreachable instance, a bad key, or an unknown dataset throws here and the
 * stage fails loudly in global setup. Both calls retry once on infrastructure
 * failures; a rejected call (HTTP 200 + non-zero `code` — the table's
 * rejection shape) is a configuration or upstream problem, is never retried,
 * and fails the stage before any probe runs.
 */
export const wipeTestDataset = async (): Promise<void> => {
  const listed = await listDocuments()
  if (listed.payload['code'] !== 0) {
    throw new LiveUpstreamError(
      `preflight list was rejected (code ${String(listed.payload['code'])}) — ` +
        `check RAGFLOW_DATASET_ID points at the dedicated test dataset`,
    )
  }
  const ids = listDocsOf(listed.payload)
    .filter((doc) => doc.id !== undefined)
    .map((doc) => doc.id as string)
  if (ids.length === 0) return
  const deleted = await deleteDocuments(ids)
  if (deleted.payload['code'] !== 0) {
    throw new LiveUpstreamError(
      `preflight wipe was rejected (code ${String(deleted.payload['code'])}) — leftover documents remain in the test dataset`,
    )
  }
}
