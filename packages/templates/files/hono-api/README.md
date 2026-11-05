# {{projectName}}

HTTP API on [Hono](https://hono.dev) + Node.js, TypeScript, zod request validation. Scaffolded by
Forge (`hono-api`).

## Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm install`       | Install dependencies                      |
| `npm run dev`       | Watch mode on http://localhost:3000       |
| `npm run build`     | Compile to `dist/`                        |
| `npm start`         | Run the compiled server                   |
| `npm run typecheck` | TypeScript, no emit                       |
| `npm run lint`      | ESLint                                    |
| `npm test`          | Unit tests (Vitest, `app.request()`)      |

## Endpoints

- `GET /health` liveness probe (used by Docker and the Forge deployer).
- `POST /v1/echo` validated request example (`{ message: string, uppercase?: boolean }`).

Every request gets secure headers and a body size limit; CORS is off unless `CORS_ORIGINS` is set.
Configuration is validated at startup in `src/env.ts`.

## Deploy

```sh
docker build -t {{projectSlug}} . && docker run -p 3000:3000 {{projectSlug}}
```

The image runs as the unprivileged `node` user. Forge deploys it to EU regions.
