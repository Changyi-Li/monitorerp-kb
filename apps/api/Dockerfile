# Production image for the MonitorERP KB API (monitorerp-api).
#
# Multi-stage build on Node 20 (the app's engines requirement is >=20):
#   - build stage: install, typecheck, compile to dist/
#   - runtime stage: production-only dependencies plus the compiled output
#
# Boot behaviour is the app's own (src/index.ts): committed migrations apply
# on boot, the super admin is seeded when the users table is empty, and the
# server listens on $PORT (contract default 4801). The image carries no dev
# tooling and no sources — only dist/ and the committed SQL migrations (tsc
# emits only JS, so the migrations ride along in the build stage).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build
# tsc does not copy .sql files — dist/db/migrations must be copied by hand.
RUN cp -r src/db/migrations dist/db/migrations

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4801
USER node
CMD ["node", "dist/index.js"]
