# Production image for the MonitorERP KB web app (kb-web).
#
# Multi-stage build on Node 22 (the app's engines requirement is >=22):
#   - build stage: install and production build with standalone output
#   - runtime stage: the traced standalone runtime (server.js) plus the static
#     assets and the public files — standalone does not copy those itself, and
#     without them the production UI would 404 on every asset
#
# Boot behaviour is the standalone server's: HOSTNAME=0.0.0.0 is pinned
# because Docker injects HOSTNAME=<container-id> into every container — the
# server's own fallback (0.0.0.0) never fires inside one, and binding the
# container's bridge IP would leave the nginx proxy and the localhost
# healthchecks unable to reach it. The port comes from $PORT (contract
# default 4800).
#
# The API origin is baked, not passed: the standalone output serializes
# next.config's rewrites() at build time — a runtime API_ORIGIN env var can
# never reach the /api/* rewrite destination. The contract value (the compose
# service name "api", fixed by the deployment topology) is therefore declared
# here in the build stage; the runtime stage carries the same value so the
# streaming route handler (app/api/chat/completions/route.ts, which does read
# API_ORIGIN at runtime) and the baked rewrite can never disagree. Nothing is
# passed to the build — no build-time environment values, no build args.

FROM node:22-alpine AS build
ENV API_ORIGIN=http://api:4801
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV API_ORIGIN=http://api:4801
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 4800
USER node
CMD ["node", "server.js"]
