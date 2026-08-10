import type { Config } from './config.js'
import type { DB } from './db/client.js'
import type { AgentClient } from './ragflow/agent.js'
import type { RagflowClient } from './ragflow/client.js'

/** The shared application wiring passed to routes and middleware. */
export interface Deps {
  db: DB
  config: Config
  ragflow: RagflowClient
  agent: AgentClient
}
