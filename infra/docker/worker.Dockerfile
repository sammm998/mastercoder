# Shared image for Forge Node services (api, agent-worker).
# Railway: set the service's config file to apps/<service>/railway.json.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
ARG SERVICE=agent-worker
ENV SERVICE=${SERVICE}
# Default to local object storage + mock providers unless the Railway variables say otherwise.
ENV STORAGE_PROVIDER=local LOCAL_STORAGE_DIR=/data/storage
# worker has no HTTP port
CMD ["sh", "-c", "pnpm --filter @forge/${SERVICE} start"]
