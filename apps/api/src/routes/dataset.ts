import { Hono } from 'hono'
import { authMiddleware } from '../auth/middleware.js'
import type { Deps } from '../deps.js'
import { sendError } from '../errors.js'
import { RagflowError } from '../ragflow/client.js'

/**
 * The configured RagFlow dataset's display name (issue #40): read from
 * RagFlow at runtime, never baked into a client bundle. The web shell
 * fetches this server-side and renders the name in the sidebar.
 */
export function datasetRoutes(deps: Deps): Hono {
  const app = new Hono()

  app.get('/', authMiddleware(deps), async (c) => {
    try {
      const { name } = await deps.ragflow.getDataset()
      return c.json({ name })
    } catch (err) {
      if (err instanceof RagflowError) {
        return sendError(c, 502, 'upstream_error', 'RagFlow is unavailable')
      }
      throw err
    }
  })

  return app
}
