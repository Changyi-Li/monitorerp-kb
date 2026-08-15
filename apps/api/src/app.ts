import { Hono } from 'hono'
import type { Deps } from './deps.js'
import { sendError } from './errors.js'
import { createAgentClient } from './ragflow/agent.js'
import { createRagflowClient } from './ragflow/client.js'
import { authRoutes } from './routes/auth.js'
import { chatRoutes } from './routes/chat.js'
import { datasetRoutes } from './routes/dataset.js'
import { documentsRoutes } from './routes/documents.js'
import { oidcRoutes } from './routes/oidc.js'
import { usersRoutes } from './routes/users.js'

export function createApp(deps: Deps): Hono {
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true }))
  app.route('/auth', authRoutes(deps))
  app.route('/auth/oidc', oidcRoutes(deps))
  app.route('/chat', chatRoutes(deps))
  app.route('/dataset', datasetRoutes(deps))
  app.route('/documents', documentsRoutes(deps))
  app.route('/users', usersRoutes(deps))
  app.notFound((c) => sendError(c, 404, 'not_found', 'Not found'))
  app.onError((err, c) => {
    console.error(err)
    return sendError(c, 500, 'internal', 'Internal server error')
  })
  return app
}

/** Builds the app and its application wiring from configuration. */
export function createConfiguredApp(deps: { db: Deps['db']; config: Deps['config'] }): Hono {
  return createApp({
    ...deps,
    ragflow: createRagflowClient(deps.config),
    agent: createAgentClient(deps.config),
  })
}
