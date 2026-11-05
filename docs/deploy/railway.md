# Deploying Forge on Railway

Forge is a monorepo with several services. On Railway each one is its own **service** in one project,
all built from this repository with config-as-code.

| Railway service | Config file (Settings → Config-as-code) | What it runs |
|---|---|---|
| `api` | `apps/api/railway.json` (also the repo-root `railway.json`) | Fastify + tRPC + WebSockets, port `$PORT` |
| `worker` | `apps/agent-worker/railway.json` | BullMQ workers (media, slides, meetings, agent runs, scans, builds) |
| `web` | `apps/web/railway.json` | Next.js platform UI (port `$PORT`) |
| Postgres | Railway **pgvector** template (needs the `vector` extension) | database |
| Redis | Railway Redis | queues, pub/sub, rate limits |

Pick the **EU West (Amsterdam)** region for every service to keep data in the EU.

## Steps

1. **New project → Deploy from GitHub repo → `sammm998/mastercoder`.** Choose branch
   `main`. If Railway shows
   "Failed to fetch repository files", check GitHub → Settings → Applications → Railway → Repository access
   includes this repo, and check Railway's status banner.
2. The first service uses the root `railway.json` → it becomes the **api**. Rename it `api`.
3. **+ New → Database → pgvector** (template) and **+ New → Database → Redis**.
4. **+ New → GitHub repo** again (same repo/branch) for the **worker**; in its Settings set
   *Config-as-code path* to `apps/agent-worker/railway.json`.
5. Variables (Settings → Variables). Use Railway references for the databases:

   Shared by api and worker:
   ```
   DATABASE_URL=${{pgvector.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   VAULT_MASTER_KEY=<openssl rand -hex 32>   # same value on both services
   AUTH_SECRET=<openssl rand -hex 32>
   DATA_REGION=eu-west
   LLM_PROVIDER=mock                        # or anthropic + ANTHROPIC_API_KEY
   EMAIL_PROVIDER=mock                      # or smtp + SMTP_URL / EMAIL_FROM
   STORAGE_PROVIDER=local                   # or s3 + S3_* (Railway bucket or any EU S3)
   SANDBOX_PROVIDER=e2b                     # worker: Railway has no Docker daemon → e2b or daytona (+ API key)
   ```
   api only:
   ```
   APP_URL=https://<web domain>
   API_URL=https://<api domain>
   COOKIE_SAME_SITE=none   # only when web and api use the default *.up.railway.app domains
   ```
6. **api → Settings → Networking → Generate domain.** Health check: `GET /health`.
7. **+ New → GitHub repo** (same repo, branch `main`) for the **web**; config-as-code path `apps/web/railway.json`.
   Variable `NEXT_PUBLIC_API_URL=https://<api domain>` (used at build time — redeploy web after changing it).
   Generate a domain, then set the api's `APP_URL` to it. Sessions use cookies, so put api and web on the
   same parent domain (e.g. `api.example.com` + `app.example.com`) with a custom domain on each.
8. Migrations run automatically when the api and worker start.

## Notes
- `STORAGE_PROVIDER=local` stores files on the container disk (lost on redeploy). Attach a Railway volume at
  `/data` or use S3 for anything real.
- The worker cannot use `SANDBOX_PROVIDER=docker` on Railway (no Docker-in-Docker). Builds need E2B or Daytona.
- PDF export and visual QA use Chromium, which the slim images don't include; those features report an error
  until a Chromium layer is added.
- Everything defaults to mock providers, so a fresh deploy works without any vendor keys.
