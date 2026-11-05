"""Forge AI gateway client: chat, image, speech-to-text, text-to-speech.

Server-side only: FORGE_PROJECT_TOKEN must never be sent to browsers. Usage is metered per project
and capped by the project's spending limit (HTTP 402 when reached).
"""

import base64
import os
from dataclasses import dataclass
from typing import Any, Literal

import httpx


class ForgeAIError(Exception):
    def __init__(self, message: str, status: int, code: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass
class ChatResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


def _config() -> tuple[str, str]:
    url = os.environ.get("FORGE_AI_GATEWAY_URL")
    token = os.environ.get("FORGE_PROJECT_TOKEN")
    if not url or not token:
        raise RuntimeError("FORGE_AI_GATEWAY_URL and FORGE_PROJECT_TOKEN must be set")
    return url.rstrip("/"), token


async def _post(route: str, body: dict[str, Any], request_timeout: float = 120.0) -> httpx.Response:
    url, token = _config()
    async with httpx.AsyncClient(timeout=request_timeout) as client:
        res = await client.post(f"{url}/v1/{route}", json=body, headers={"Authorization": f"Bearer {token}"})
    if res.status_code >= 400:
        try:
            err = res.json()
        except ValueError:
            err = {}
        raise ForgeAIError(
            str(err.get("message", f"Forge AI {route} failed ({res.status_code})")),
            res.status_code,
            str(err.get("error", "error")),
        )
    return res


async def chat(
    messages: list[dict[str, str]],
    system: str | None = None,
    max_tokens: int | None = None,
    tier: Literal["fast", "standard", "smart"] = "standard",
) -> ChatResult:
    body: dict[str, Any] = {"messages": messages, "tier": tier}
    if system:
        body["system"] = system
    if max_tokens:
        body["maxTokens"] = max_tokens
    data = (await _post("chat", body)).json()
    return ChatResult(
        text=data["text"],
        model=data["model"],
        input_tokens=data["usage"]["inputTokens"],
        output_tokens=data["usage"]["outputTokens"],
        cost_usd=data["costUsd"],
    )


async def ask(prompt: str, **kwargs: Any) -> str:
    return (await chat([{"role": "user", "content": prompt}], **kwargs)).text


async def generate_image(prompt: str, size: str = "1024x1024", n: int = 1) -> list[tuple[str, bytes]]:
    """Returns (media type, bytes) per image."""
    data = (await _post("image", {"prompt": prompt, "size": size, "n": n}, request_timeout=300.0)).json()
    return [(img["mediaType"], base64.b64decode(img["data"])) for img in data["images"]]


async def speech_to_text(audio: bytes, media_type: str, language: str | None = None) -> str:
    body: dict[str, Any] = {"audio": base64.b64encode(audio).decode("ascii"), "mediaType": media_type}
    if language:
        body["language"] = language
    data = (await _post("stt", body, request_timeout=300.0)).json()
    return str(data["text"])


async def text_to_speech(
    text: str, voice: str | None = None, fmt: Literal["mp3", "wav"] = "mp3"
) -> tuple[str, bytes]:
    """Returns (media type, audio bytes)."""
    body: dict[str, Any] = {"text": text, "format": fmt}
    if voice:
        body["voice"] = voice
    res = await _post("tts", body)
    return res.headers.get("content-type", "audio/mpeg"), res.content
