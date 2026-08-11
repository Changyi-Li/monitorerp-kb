// Environment contract for the live RagFlow gate (spec #28, stage (b) /
// ticket #37). The gate drives the full stack against the REAL RagFlow
// instance, never the stub — when any of the four variables is missing it
// fails loudly with a clear message instead of silently skipping (user
// story 15).

export const LIVE_RAGFLOW_VARS = ['RAGFLOW_URL', 'RAGFLOW_API_KEY', 'RAGFLOW_DATASET_ID', 'RAGFLOW_AGENT_ID'] as const

export interface LiveEnv {
  ragflowUrl: string
  ragflowApiKey: string
  /** The dedicated TEST dataset (embedder + chunk method configured). */
  ragflowDatasetId: string
  /** The dedicated TEST agent (retrieval node + model). */
  ragflowAgentId: string
}

export function loadLiveEnv(env: NodeJS.ProcessEnv = process.env): LiveEnv {
  const missing = LIVE_RAGFLOW_VARS.filter((name) => (env[name] ?? '') === '')
  if (missing.length > 0) {
    throw new Error(
      `The live RagFlow e2e gate is missing ${missing.join(', ')}. ` +
        `It drives the full stack against the REAL RagFlow instance, never the stub — ` +
        `set RAGFLOW_URL and RAGFLOW_API_KEY to the existing deployment, and point ` +
        `RAGFLOW_DATASET_ID and RAGFLOW_AGENT_ID at the dedicated TEST dataset and TEST ` +
        `agent created in the RagFlow UI (see ../api/readme.md, "Release gate").`,
    )
  }
  // The guard above guarantees every variable is non-empty.
  const value = (name: (typeof LIVE_RAGFLOW_VARS)[number]): string => env[name] ?? ''
  return {
    ragflowUrl: value('RAGFLOW_URL'),
    ragflowApiKey: value('RAGFLOW_API_KEY'),
    ragflowDatasetId: value('RAGFLOW_DATASET_ID'),
    ragflowAgentId: value('RAGFLOW_AGENT_ID'),
  }
}
