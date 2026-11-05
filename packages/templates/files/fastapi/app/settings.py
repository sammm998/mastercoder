from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated configuration from environment variables (and `.env` in development)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "{{projectSlug}}"
    environment: str = Field(default="development", pattern="^(development|test|production)$")
    port: int = Field(default=8000, ge=1, le=65535)
    #: Comma-separated browser origins allowed to call the API. Empty = same-origin only.
    cors_origins: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
