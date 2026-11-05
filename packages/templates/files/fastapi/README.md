# {{projectName}}

HTTP API on FastAPI with pydantic validation, served by uvicorn. Scaffolded by Forge (`fastapi`).

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

| Command                                  | What it does                   |
| ---------------------------------------- | ------------------------------ |
| `.venv/bin/uvicorn app.main:app --reload`| Dev server on :8000            |
| `.venv/bin/pytest -q`                    | Tests (FastAPI TestClient)     |
| `.venv/bin/mypy app tests`               | Strict type checking           |
| `.venv/bin/ruff check .`                 | Lint                           |
| `.venv/bin/ruff format --check .`        | Formatting check               |

## Endpoints

- `GET /health` liveness probe.
- `POST /v1/echo` validated request example (`EchoIn` in `app/schemas.py`; unknown fields rejected).
- `GET /docs` OpenAPI UI (disabled when `ENVIRONMENT=production`).

Configuration is validated by `pydantic-settings` in `app/settings.py`.

## Deploy

```sh
docker build -t {{projectSlug}} . && docker run -p 8000:8000 {{projectSlug}}
```

The image runs as an unprivileged user. Forge deploys it to EU regions.
