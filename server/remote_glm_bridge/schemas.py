from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolManifestEntry(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class FileState(BaseModel):
    path: str
    sha256: str | None = None
    content: str | None = None
    summary: str | None = None
    is_partial: bool = False


class WorkspaceSnapshot(BaseModel):
    workspace_id: str
    cwd: str
    branch: str | None = None
    files: list[FileState] = Field(default_factory=list)
    memory: str | None = None


class ConversationMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class SecondaryProcessorConfig(BaseModel):
    enabled: bool = False
    model: str | None = None
    endpoint: str | None = None


class SessionCreateRequest(BaseModel):
    session_label: str
    user_id: str
    system_prompt: str = ""
    workspace: WorkspaceSnapshot
    tool_manifest: list[ToolManifestEntry] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionCreateResponse(BaseModel):
    session_id: str
    websocket_url: str
    expires_at: datetime


class TurnRequest(BaseModel):
    turn_id: str
    prompt: str
    messages: list[ConversationMessage] = Field(default_factory=list)
    workspace_patch: WorkspaceSnapshot | None = None
    tool_manifest: list[ToolManifestEntry] = Field(default_factory=list)
    secondary_processor: SecondaryProcessorConfig = Field(
        default_factory=SecondaryProcessorConfig,
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionStateResponse(BaseModel):
    session_id: str
    session_label: str
    user_id: str
    created_at: datetime
    updated_at: datetime
    tool_count: int
    workspace_id: str


class ClientEnvelope(BaseModel):
    type: Literal["session.configure", "turn.start", "tool.result", "session.close"]
    payload: dict[str, Any] = Field(default_factory=dict)


class ServerEnvelope(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
