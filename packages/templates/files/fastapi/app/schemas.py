from pydantic import BaseModel, ConfigDict, Field


class Health(BaseModel):
    status: str
    service: str


class EchoIn(BaseModel):
    """Validated request example: unknown fields are rejected, lengths are bounded."""

    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=2000)
    uppercase: bool = False


class EchoOut(BaseModel):
    message: str
