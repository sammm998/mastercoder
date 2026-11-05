# syntax=docker/dockerfile:1
# Production image for the web build of the app (Expo web export), served by unprivileged nginx on
# :8080. Native iOS/Android binaries are built with EAS (`eas build`), not Docker.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# Optional build secret "ca" (extra root CA, e.g. a corporate proxy). Ignored when absent.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npx expo export --platform web --output-dir dist

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
