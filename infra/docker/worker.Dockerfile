# Shared image for Forge Node services (api, agent-worker).
# Railway: set the service's config file to apps/<service>/railway.json.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_ENV=production
RUN corepack enable
# Tools the build sandbox needs: curl (preview probe), git, and the system libraries Chromium needs so
# generated projects' Playwright/Lighthouse runs can launch a browser.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && npx -y playwright@1.63.0 install-deps chromium \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter "@forge/agent-worker..." && pnpm store prune
# Chromium for Lighthouse, visual QA and slide rendering (same Playwright version as the workspace).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd apps/agent-worker && node_modules/.bin/playwright install chromium
ARG SERVICE=agent-worker
ENV SERVICE=${SERVICE}
# Default to local object storage + mock providers unless the Railway variables say otherwise.
ENV STORAGE_PROVIDER=local LOCAL_STORAGE_DIR=/data/storage
# worker has no HTTP port
CMD ["sh", "-c", "pnpm --filter @forge/${SERVICE} start"]
