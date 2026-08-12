#!/usr/bin/env bash
# Smoke harness (issue #45): boot the locally built production images under
# the deployment env shape and assert the health chain, in order:
#
#   1. API health endpoint   — http://127.0.0.1:4801/health
#   2. Web sign-in page      — http://127.0.0.1:4800/auth/sign-in
#   3. Web→API rewrite       — POST /api/auth/sign-in through the web origin
#
# Nothing is published or pulled: compose.smoke.yml builds both images from
# source (local builds only), and the release workflow runs this script
# between build and publish. Requires: docker compose, curl, and the API
# dependencies installed (`npm ci` in apps/api — the RagFlow stub runs on
# the host through tsx). Stop any dev servers on :4800/:4801 first — the
# harness needs the contract ports.
#
# The environment mirrors the deployment contract (deploy repo's kb stack):
# the API reaches Postgres and RagFlow via host.docker.internal (host-gateway,
# the server-side pattern), and the in-repo RagFlow stub stands in for
# RagFlow — a shape mirror only: the API never dials RagFlow for the smoke's
# assertions (the spec exempts live RagFlow), so the sides this harness does
# exercise — the database URL, the web's API origin, the contract ports —
# are what red loudly when a contract change forgets one side. The API's
# committed migrations apply from zero against a fresh monitorerp_kb_smoke
# database on the dev-compose Postgres, so a broken image or migration reds
# here.
#
# Image overrides (the deliberately-broken check): set SMOKE_API_IMAGE /
# SMOKE_WEB_IMAGE to reuse already-built images instead of building them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_SMOKE=(docker compose -f compose.smoke.yml)
STUB_PORT=9399
STUB_URL="http://127.0.0.1:$STUB_PORT/health"
SMOKE_DB=monitorerp_kb_smoke
ADMIN_EMAIL=smoke@monitorerp.local
ADMIN_PASSWORD=smoke-admin-password

fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

cleanup() {
  "${COMPOSE_SMOKE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  if [ -n "${STUB_LOG:-}" ] && [ -f "$STUB_LOG" ]; then rm -f "$STUB_LOG"; fi
}
trap cleanup EXIT

echo "== Smoke harness: containerized boot under the production env shape =="

# 0. A stale stub from an interrupted run (or a foreign service) must not be
#    silently reused.
curl -fsS -m 1 "$STUB_URL" >/dev/null 2>&1 \
  && fail "port $STUB_PORT already answers ($STUB_URL) — stop the previous smoke run's RagFlow stub first"

# 1. Dev-compose Postgres — the smoke's database server (published on :5433).
docker compose up -d --wait

# 2. Fresh smoke database, so the committed migrations apply from zero every
#    run (a broken migration reds the harness at API boot) and the super
#    admin seeds with the smoke credentials. The dev database is untouched.
docker compose exec -T postgres dropdb -U monitorerp --if-exists "$SMOKE_DB"
docker compose exec -T postgres createdb -U monitorerp -O monitorerp "$SMOKE_DB"

# 3. The in-repo RagFlow stub on the host, standing in for RagFlow at the
#    deploy-shaped URL http://host.docker.internal:9399. Nothing in the
#    smoke's assertions dials it (the API only validates the vars at boot),
#    so the leg is a shape mirror — the stub's job is to exist and answer on
#    the host (Docker Desktop containers can reach host-loopback services;
#    Linux runners cannot reach a loopback-bound stub, but nothing dials it).
#    exec collapses the subshell so $! is the node process itself and kill
#    actually reaches it (npx would spawn a child node that outlives the
#    subshell on Windows).
STUB_LOG="$(mktemp)"
(
  cd apps/api
  exec node --import tsx e2e/ragflow-stub-server.ts >"$STUB_LOG" 2>&1
) &
STUB_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$STUB_URL" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "$STUB_URL" >/dev/null 2>&1; then
  echo "RagFlow stub did not answer on $STUB_URL — last log lines:" >&2
  tail -20 "$STUB_LOG" >&2 || true
  fail "RagFlow stub failed to boot"
fi

# 4. Build both images from source (unless overridden), boot them under the
#    production env shape, and wait on the deployment healthchecks — a broken
#    image or a crashed boot reds here before any assertion runs.
if [ -z "${SMOKE_API_IMAGE:-}" ]; then "${COMPOSE_SMOKE[@]}" build api; fi
if [ -z "${SMOKE_WEB_IMAGE:-}" ]; then "${COMPOSE_SMOKE[@]}" build web; fi
"${COMPOSE_SMOKE[@]}" up -d --wait

# 5. The three assertions, in order.
echo -n "[1/3] API health endpoint ... "
curl -fsS http://127.0.0.1:4801/health | grep -q '"ok":true' \
  || fail "API /health did not answer 200"
echo "ok"

echo -n "[2/3] Web sign-in page ... "
curl -fsS -o /dev/null http://127.0.0.1:4800/auth/sign-in \
  || fail "web sign-in page did not answer 200"
echo "ok"

echo -n "[3/3] Web→API rewrite (POST /api/auth/sign-in through the web) ... "
# The browser's own path: the sign-in form posts to /api/auth/sign-in, which
# the web rewrites to http://api:4801/auth/sign-in — proving the rewrite, the
# API auth, and the seeded super admin together.
curl -fsS -o /dev/null \
  -X POST http://127.0.0.1:4800/api/auth/sign-in \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  || fail "web→api rewrite did not answer 200"
echo "ok"

echo "== Smoke harness PASSED: healthy images boot and answer under the production env shape =="
