# Forge platform UI (Next.js). Railway: config file apps/web/railway.json.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter "@forge/web..." && pnpm store prune
# The browser talks to the API directly, so its public URL is baked in at build time.
# Railway passes service variables with a matching ARG to the build.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @forge/web build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "WEB_PORT=${PORT:-3000} pnpm --filter @forge/web start"]
