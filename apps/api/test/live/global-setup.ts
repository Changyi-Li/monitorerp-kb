import { RAGFLOW_VERSION_VALIDATED } from '../ragflow-wire.js'
import { loadLiveEnv } from './env.js'
import { wipeTestDataset } from './ragflow-http.js'

/**
 * Stage (c) preflight (ticket #35): fail loudly — never a silent skip — when
 * the four RagFlow env vars are missing or the instance is unreachable, then
 * wipe the test dataset so leftovers from a crashed run can't poison
 * assertions. Runs once before the suite; a throw here reddens the whole
 * stage with a clear message.
 */
export default async function globalSetup(): Promise<void> {
  const env = loadLiveEnv()
  console.log(
    `[revalidation] auditing the ${RAGFLOW_VERSION_VALIDATED}-verified expectations table ` +
      `against the live instance at ${env.ragflowUrl}`,
  )
  await wipeTestDataset()
  console.log('[revalidation] preflight wipe complete — test dataset is empty')
}
