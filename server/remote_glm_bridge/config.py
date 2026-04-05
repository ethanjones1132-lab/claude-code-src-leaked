from __future__ import annotations

from dataclasses import dataclass
import os


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    bridge_api_keys: list[str]
    primary_base_url: str
    primary_api_key: str | None
    primary_model: str
    fast_base_url: str
    fast_api_key: str | None
    fast_model: str
    auto_model_alias: str
    request_timeout_seconds: float
    healthcheck_timeout_seconds: float
    secondary_base_url: str | None
    secondary_api_key: str | None
    secondary_model: str | None


def _getenv_any(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value is not None and value != "":
            return value
    return default


def load_settings() -> Settings:
    return Settings(
        host=_getenv_any("GPT_OSS_BRIDGE_HOST", "GLM_BRIDGE_HOST", default="0.0.0.0")
        or "0.0.0.0",
        port=int(
            _getenv_any("GPT_OSS_BRIDGE_PORT", "GLM_BRIDGE_PORT", default="8787")
            or "8787"
        ),
        bridge_api_keys=_split_csv(
            _getenv_any("GPT_OSS_BRIDGE_API_KEYS", "GLM_BRIDGE_API_KEYS")
        ),
        primary_base_url=_getenv_any(
            "GPT_OSS_BASE_URL",
            "REMOTE_OSS_BASE_URL",
            "GLM_BASE_URL",
            default="http://127.0.0.1:8000/v1",
        )
        or "http://127.0.0.1:8000/v1",
        primary_api_key=_getenv_any(
            "GPT_OSS_API_KEY",
            "REMOTE_OSS_API_KEY",
            "GLM_API_KEY",
        ),
        primary_model=_getenv_any(
            "GPT_OSS_PRIMARY_MODEL",
            "REMOTE_OSS_PRIMARY_MODEL",
            "GLM_MODEL",
            default="gpt-oss-120b",
        )
        or "gpt-oss-120b",
        fast_base_url=_getenv_any(
            "GPT_OSS_FAST_BASE_URL",
            "REMOTE_OSS_FAST_BASE_URL",
            "GPT_OSS_BASE_URL",
            "REMOTE_OSS_BASE_URL",
            "GLM_BASE_URL",
            default="http://127.0.0.1:8000/v1",
        )
        or "http://127.0.0.1:8000/v1",
        fast_api_key=_getenv_any(
            "GPT_OSS_FAST_API_KEY",
            "REMOTE_OSS_FAST_API_KEY",
            "GPT_OSS_API_KEY",
            "REMOTE_OSS_API_KEY",
            "GLM_API_KEY",
        ),
        fast_model=_getenv_any(
            "GPT_OSS_FAST_MODEL",
            "REMOTE_OSS_FAST_MODEL",
            default="gpt-oss-20b",
        )
        or "gpt-oss-20b",
        auto_model_alias=_getenv_any(
            "GPT_OSS_AUTO_MODEL_ALIAS",
            "REMOTE_OSS_AUTO_MODEL_ALIAS",
            default="gpt-oss-auto",
        )
        or "gpt-oss-auto",
        request_timeout_seconds=float(
            _getenv_any(
                "GPT_OSS_BRIDGE_REQUEST_TIMEOUT_SECONDS",
                "GLM_BRIDGE_REQUEST_TIMEOUT_SECONDS",
                default="300",
            )
            or "300"
        ),
        healthcheck_timeout_seconds=float(
            _getenv_any(
                "GPT_OSS_BRIDGE_HEALTHCHECK_TIMEOUT_SECONDS",
                "GLM_BRIDGE_HEALTHCHECK_TIMEOUT_SECONDS",
                default="8",
            )
            or "8"
        ),
        secondary_base_url=os.getenv("SECONDARY_MODEL_BASE_URL"),
        secondary_api_key=os.getenv("SECONDARY_MODEL_API_KEY"),
        secondary_model=os.getenv("SECONDARY_MODEL_NAME"),
    )
