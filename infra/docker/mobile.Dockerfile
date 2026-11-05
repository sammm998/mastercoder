# Forge mobile app, web build (Expo export, served as static files).
# Native iOS/Android builds go through EAS, not Railway.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true EXPO_NO_TELEMETRY=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --filter "@forge/mobile..."
ARG EXPO_PUBLIC_API_URL=http://localhost:4000
ENV EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL}
RUN pnpm --filter @forge/mobile export:web

FROM node:22-bookworm-slim
RUN npm install -g serve@14.2.4 --no-audit --no-fund
COPY --from=build /app/apps/mobile/dist /site
EXPOSE 3000
CMD ["sh", "-c", "exec serve -s /site -l tcp://0.0.0.0:${PORT:-3000}"]
