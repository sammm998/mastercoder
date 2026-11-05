# syntax=docker/dockerfile:1
# Production image: compiled Hono API on Node, non-root, :3000.
# Runs on any OCI host; Forge deploys it to EU regions (Fly arn/ams/fra).
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# Optional build secret "ca" (extra root CA, e.g. a corporate proxy). Ignored when absent.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
