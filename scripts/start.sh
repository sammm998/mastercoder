#!/usr/bin/env bash
# One command to run the whole Forge platform locally:
#   docker services (Postgres+pgvector, Redis, S3, Mailpit) → migrations → buckets → api, worker, web, admin.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example (mock providers)"; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
export VAULT_MASTER_KEY="${VAULT_MASTER_KEY:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Start Docker and re-run." >&2
  exit 1
fi

echo "▶ starting docker services"
docker compose up -d --wait postgres redis s3 mailpit 2>/dev/null || docker compose up -d postgres redis s3 mailpit
for i in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U forge >/dev/null 2>&1 && break
  sleep 1
done

[ -d node_modules ] || pnpm install
echo "▶ migrations"
pnpm --filter @forge/db migrate
echo "▶ buckets"
pnpm exec tsx scripts/ensure-buckets.ts

echo "▶ api :4000 · worker · web :3000 · admin :3001 (Ctrl+C stops all)"
exec pnpm exec concurrently -k -n api,worker,web,admin -c blue,magenta,green,yellow \
  "pnpm --filter @forge/api start" \
  "pnpm --filter @forge/agent-worker start" \
  "pnpm --filter @forge/web dev" \
  "pnpm --filter @forge/admin dev"
