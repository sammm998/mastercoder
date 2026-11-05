"""Extension point for @forge/app-kit.

When kit features (ai, cron, observability, ...) are added, Forge regenerates this module to mount
their routers. No kit features installed.
"""

from fastapi import FastAPI


def mount_kit(app: FastAPI) -> None:
    return None
