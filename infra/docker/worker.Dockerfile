# Shared image for Forge Node services (api, agent-worker).
# Railway: set the service's config file to apps/<service>/railway.json.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_ENV=production
RUN corepack enable
# Tools the build sandbox needs: curl (preview probe), git, and the system libraries Chromium needs so
# generated projects' Playwright/Lighthouse runs can launch a browser.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && npx -y playwright@1.56.1 install-deps chromium \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter "@forge/agent-worker..." && pnpm store prune
ARG SERVICE=agent-worker
ENV SERVICE=${SERVICE}
# Default to local object storage + mock providers unless the Railway variables say otherwise.
ENV STORAGE_PROVIDER=local LOCAL_STORAGE_DIR=/data/storage
# worker has no HTTP port
CMD ["sh", "-c", "pnpm --filter @forge/${SERVICE} start"]
