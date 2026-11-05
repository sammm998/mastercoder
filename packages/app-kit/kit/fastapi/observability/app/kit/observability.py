"""Error reporting to the Forge error ingest (FORGE_ERROR_INGEST_URL), Sentry-style event fields.
Unhandled exceptions are reported, then answered with a generic 500 (no stack traces to clients)."""

import logging
import os
import traceback
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("observability")


async def report_error(
    exc: BaseException, path: str | None = None, tags: dict[str, str] | None = None
) -> None:
    endpoint = os.environ.get("FORGE_ERROR_INGEST_URL")
    token = os.environ.get("FORGE_PROJECT_TOKEN")
    if not endpoint or not token:
        log.error("unhandled error: %s", exc)
        return
    event = {
        "type": type(exc).__name__,
        "message": (str(exc) or type(exc).__name__)[:4000],
        "stack": "".join(traceback.format_exception(exc))[:20000],
        "url": path,
        "runtime": "python",
        "release": os.environ.get("APP_RELEASE"),
        "environment": os.environ.get("ENVIRONMENT", "production"),
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "tags": tags or {},
    }
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(endpoint, json=event, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        log.warning("could not report error to Forge")


def install_error_reporting(app: FastAPI) -> None:
    @app.exception_handler(Exception)
    async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
        await report_error(exc, path=request.url.path, tags={"method": request.method})
        return JSONResponse({"error": "internal_error"}, status_code=500)
