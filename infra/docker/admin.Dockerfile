# Forge internal admin (Next.js). Railway: RAILWAY_DOCKERFILE_PATH=infra/docker/admin.Dockerfile.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter "@forge/admin..." && pnpm store prune
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @forge/admin build
ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-c", "cd apps/admin && exec node_modules/.bin/next start --port ${PORT:-3001} --hostname 0.0.0.0"]
