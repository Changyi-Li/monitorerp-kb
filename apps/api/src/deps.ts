import type { Config } from './config.js'
import type { DB } from './db/client.js'

/** The shared application wiring passed to routes and middleware. */
export interface Deps {
  db: DB
  config: Config
}
