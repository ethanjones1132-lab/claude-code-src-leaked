from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import Lock
from uuid import uuid4

from .schemas import SessionCreateRequest, ToolManifestEntry, WorkspaceSnapshot


SESSION_TTL = timedelta(hours=8)


@dataclass
class BridgeSession:
    session_id: str
    session_label: str
    user_id: str
    system_prompt: str
    workspace: WorkspaceSnapshot
    tool_manifest: list[ToolManifestEntry]
    metadata: dict[str, object]
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def touch(self) -> None:
        self.updated_at = datetime.now(UTC)

    @property
    def expires_at(self) -> datetime:
        return self.updated_at + SESSION_TTL


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, BridgeSession] = {}
        self._lock = Lock()

    def create(self, request: SessionCreateRequest) -> BridgeSession:
        session = BridgeSession(
            session_id=f"oss_{uuid4().hex}",
            session_label=request.session_label,
            user_id=request.user_id,
            system_prompt=request.system_prompt,
            workspace=request.workspace,
            tool_manifest=request.tool_manifest,
            metadata=request.metadata,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> BridgeSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            if session.expires_at <= datetime.now(UTC):
                self._sessions.pop(session_id, None)
                return None
            return session

    def update_workspace(
        self,
        session_id: str,
        workspace: WorkspaceSnapshot,
    ) -> BridgeSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            session.workspace = workspace
            session.touch()
            return session

    def update_tool_manifest(
        self,
        session_id: str,
        tool_manifest: list[ToolManifestEntry],
    ) -> BridgeSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            session.tool_manifest = tool_manifest
            session.touch()
            return session
