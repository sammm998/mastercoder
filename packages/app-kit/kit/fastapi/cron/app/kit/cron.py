"""Scheduled jobs. The Forge scheduler POSTs /cron/<job> per forge.json "crons" entry with
`Authorization: Bearer $CRON_SECRET`. Register jobs in JOBS (and mirror them in forge.json)."""

import hmac
import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException

log = logging.getLogger("cron")

Job = Callable[[], Awaitable[dict[str, Any]]]


async def heartbeat() -> dict[str, Any]:
    at = datetime.now(UTC).isoformat()
    log.info("cron heartbeat at %s", at)
    return {"at": at}


JOBS: dict[str, Job] = {"heartbeat": heartbeat}

router = APIRouter(prefix="/cron", tags=["cron"])


def is_authorized(authorization: str | None) -> bool:
    secret = os.environ.get("CRON_SECRET", "")
    if len(secret) < 16 or not authorization or not authorization.lower().startswith("bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip().encode(), secret.encode())


@router.post("/{job}")
async def run_job(job: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not is_authorized(authorization):
        raise HTTPException(status_code=401, detail="unauthorized")
    fn = JOBS.get(job)
    if fn is None:
        raise HTTPException(status_code=404, detail="unknown_job")
    started = time.monotonic()
    result = await fn()
    return {
        "job": job,
        "ok": True,
        "durationMs": round((time.monotonic() - started) * 1000),
        "result": result,
    }
