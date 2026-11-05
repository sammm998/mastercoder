from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import RequestResponseEndpoint

from app.kit import mount_kit
from app.schemas import EchoIn, EchoOut, Health
from app.settings import Settings, get_settings

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or get_settings()
    app = FastAPI(title=cfg.service_name, docs_url="/docs" if cfg.environment != "production" else None)

    if cfg.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cfg.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        return response

    @app.get("/health")
    def health() -> Health:
        return Health(status="ok", service=cfg.service_name)

    @app.post("/v1/echo")
    def echo(body: EchoIn) -> EchoOut:
        return EchoOut(message=body.message.upper() if body.uppercase else body.message)

    mount_kit(app)
    return app


app = create_app()
