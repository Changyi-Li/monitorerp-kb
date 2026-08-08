import { Hono } from 'hono'
import type { Deps } from './deps.js'
import { sendError } from './errors.js'
import { authRoutes } from './routes/auth.js'

export function createApp(deps: Deps): Hono {
  const app = new Hono()
  app.route('/auth', authRoutes(deps))
  app.notFound((c) => sendError(c, 404, 'not_found', 'Not found'))
  app.onError((err, c) => {
    console.error(err)
    return sendError(c, 500, 'internal', 'Internal server error')
  })
  return app
}
