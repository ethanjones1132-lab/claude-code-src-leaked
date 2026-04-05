from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator
import json
import re

import httpx

from .config import Settings
from .protocol import (
    BridgeStreamParser,
    ParsedEvent,
    build_protocol_prompt,
    build_protocol_prompt_with_options,
)
from .schemas import (
    SecondaryProcessorConfig,
    ToolManifestEntry,
    TurnRequest,
    WorkspaceSnapshot,
)
from .session_store import BridgeSession


@dataclass(frozen=True)
class TargetModel:
    base_url: str
    api_key: str | None
    model: str
    lane: str


class OpenAICompatibleReasoningBackend:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def stream_turn(
        self,
        session: BridgeSession,
        turn: TurnRequest,
    ) -> AsyncIterator[ParsedEvent]:
        parser = BridgeStreamParser()
        payload = self._build_chat_payload(session, turn)
        target = self._resolve_target(payload["model"], payload, prefer_primary=True)
        headers = {
            "Content-Type": "application/json",
        }
        if target.api_key:
            headers["Authorization"] = f"Bearer {target.api_key}"

        async with httpx.AsyncClient(
            timeout=self._settings.request_timeout_seconds,
        ) as client:
            async with client.stream(
                "POST",
                f"{target.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:].strip()
                    if raw == "[DONE]":
                        break
                    data = json.loads(raw)
                    delta = self._extract_delta_text(data)
                    if not delta:
                        continue
                    for event in parser.feed(delta):
                        yield event

        for event in parser.flush():
            yield event

        if turn.secondary_processor.enabled:
            for event in await self._run_secondary_processor(
                turn.secondary_processor,
            ):
                yield event

    async def stream_compat_request(
        self,
        request_payload: dict[str, Any],
    ) -> AsyncIterator[ParsedEvent]:
        parser = BridgeStreamParser()
        payload = self._build_compat_chat_payload(request_payload)
        target = self._resolve_target(payload["model"], payload)
        headers = {
            "Content-Type": "application/json",
        }
        if target.api_key:
            headers["Authorization"] = f"Bearer {target.api_key}"

        async with httpx.AsyncClient(
            timeout=self._settings.request_timeout_seconds,
        ) as client:
            async with client.stream(
                "POST",
                f"{target.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:].strip()
                    if raw == "[DONE]":
                        break
                    data = json.loads(raw)
                    delta = self._extract_delta_text(data)
                    if not delta:
                        continue
                    for event in parser.feed(delta):
                        yield event

        for event in parser.flush():
            yield event

    def resolve_compat_model_name(self, request_payload: dict[str, Any]) -> str:
        payload = self._build_compat_chat_payload(request_payload)
        target = self._resolve_target(payload["model"], payload)
        return target.model

    async def health_status(self) -> dict[str, Any]:
        primary = TargetModel(
            base_url=self._settings.primary_base_url,
            api_key=self._settings.primary_api_key,
            model=self._settings.primary_model,
            lane="primary",
        )
        fast = TargetModel(
            base_url=self._settings.fast_base_url,
            api_key=self._settings.fast_api_key,
            model=self._settings.fast_model,
            lane="fast",
        )

        statuses: dict[str, dict[str, Any]] = {}
        statuses["primary"] = await self._probe_target(primary)

        if (
            fast.base_url == primary.base_url
            and fast.model == primary.model
            and fast.api_key == primary.api_key
        ):
            statuses["fast"] = {
                **statuses["primary"],
                "lane": "fast",
                "model": fast.model,
            }
        else:
            statuses["fast"] = await self._probe_target(fast)

        ready = bool(statuses["primary"].get("ok"))
        if self._settings.fast_model.strip():
            ready = ready and bool(statuses["fast"].get("ok"))

        return {
            "ok": ready,
            "ready": ready,
            "auto_model_alias": self._settings.auto_model_alias,
            "upstreams": statuses,
        }

    def estimate_compat_input_tokens(self, request_payload: dict[str, Any]) -> int:
        payload = self._build_compat_chat_payload(request_payload)
        joined = "\n".join(
            str(message.get("content", ""))
            for message in payload.get("messages", [])
        )
        return max(1, len(joined) // 4)

    def _build_chat_payload(
        self,
        session: BridgeSession,
        turn: TurnRequest,
    ) -> dict[str, Any]:
        tool_manifest = turn.tool_manifest or session.tool_manifest
        workspace = turn.workspace_patch or session.workspace
        messages: list[dict[str, str]] = [
            {
                "role": "system",
                "content": build_protocol_prompt(tool_manifest),
            }
        ]

        if session.system_prompt.strip():
            messages.append(
                {"role": "system", "content": session.system_prompt.strip()}
            )

        messages.append(
            {
                "role": "system",
                "content": self._render_workspace_snapshot(workspace),
            }
        )

        messages.extend(
            {"role": message.role, "content": message.content}
            for message in turn.messages
        )
        messages.append({"role": "user", "content": turn.prompt})

        return {
            "model": self._settings.primary_model,
            "stream": True,
            "messages": messages,
            "temperature": 0.2,
        }

    def _build_compat_chat_payload(
        self,
        request_payload: dict[str, Any],
    ) -> dict[str, Any]:
        tools = self._normalize_tool_manifest(request_payload.get("tools"))
        allow_thinking = self._thinking_enabled(request_payload.get("thinking"))
        forced_tool_name = self._forced_tool_name(request_payload.get("tool_choice"))

        messages: list[dict[str, str]] = [
            {
                "role": "system",
                "content": build_protocol_prompt_with_options(
                    tools,
                    allow_thinking=allow_thinking,
                    forced_tool_name=forced_tool_name,
                ),
            }
        ]

        system_prompt = self._normalize_system_prompt(request_payload.get("system"))
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        for message in request_payload.get("messages", []) or []:
            normalized = self._normalize_compat_message(message)
            if normalized:
                messages.append(normalized)

        model_name = str(request_payload.get("model") or self._settings.auto_model_alias)
        return {
            "model": model_name,
            "stream": True,
            "messages": messages,
            "temperature": request_payload.get("temperature", 0.2),
            "max_tokens": request_payload.get("max_tokens", 4096),
        }

    def _render_workspace_snapshot(self, workspace: WorkspaceSnapshot) -> str:
        file_lines = []
        for file_state in workspace.files:
            file_lines.append(
                json.dumps(
                    {
                        "path": file_state.path,
                        "sha256": file_state.sha256,
                        "is_partial": file_state.is_partial,
                        "summary": file_state.summary,
                        "content": file_state.content,
                    },
                    separators=(",", ":"),
                )
            )

        memory_block = workspace.memory.strip() if workspace.memory else ""
        file_block = "\n".join(file_lines) if file_lines else "(no file payload)"
        branch = workspace.branch or "(unknown branch)"
        return (
            f"<workspace id=\"{workspace.workspace_id}\" cwd=\"{workspace.cwd}\" branch=\"{branch}\">\n"
            f"<memory>{memory_block}</memory>\n"
            f"<files>\n{file_block}\n</files>\n"
            "</workspace>"
        )

    def _extract_delta_text(self, payload: dict[str, Any]) -> str:
        choices = payload.get("choices")
        if not choices:
            return ""
        delta = choices[0].get("delta", {})
        content = delta.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                elif isinstance(item, dict) and item.get("type") in {
                    "reasoning_text",
                    "reasoning",
                }:
                    parts.append(str(item.get("text", "") or item.get("content", "")))
            return "".join(parts)
        return ""

    def _normalize_tool_manifest(
        self,
        tools: Any,
    ) -> list[ToolManifestEntry]:
        normalized: list[ToolManifestEntry] = []
        if not isinstance(tools, list):
            return normalized
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            name = str(tool.get("name", "")).strip()
            if not name:
                continue
            normalized.append(
                ToolManifestEntry(
                    name=name,
                    description=str(tool.get("description", "")).strip(),
                    input_schema=tool.get("input_schema") or {},
                )
            )
        return normalized

    def _thinking_enabled(self, thinking: Any) -> bool:
        if not isinstance(thinking, dict):
            return False
        thinking_type = str(thinking.get("type", "")).strip().lower()
        return thinking_type in {"enabled", "adaptive"}

    def _forced_tool_name(self, tool_choice: Any) -> str | None:
        if not isinstance(tool_choice, dict):
            return None
        if str(tool_choice.get("type", "")).strip().lower() != "tool":
            return None
        name = str(tool_choice.get("name", "")).strip()
        return name or None

    def _resolve_target(
        self,
        requested_model: Any,
        request_payload: dict[str, Any],
        *,
        prefer_primary: bool = False,
    ) -> TargetModel:
        requested = str(requested_model or "").strip()
        primary = TargetModel(
            base_url=self._settings.primary_base_url,
            api_key=self._settings.primary_api_key,
            model=self._settings.primary_model,
            lane="primary",
        )
        fast = TargetModel(
            base_url=self._settings.fast_base_url,
            api_key=self._settings.fast_api_key,
            model=self._settings.fast_model,
            lane="fast",
        )

        if prefer_primary:
            return primary

        requested_lower = requested.lower()
        primary_lower = self._settings.primary_model.lower()
        fast_lower = self._settings.fast_model.lower()
        auto_lower = self._settings.auto_model_alias.lower()

        if requested_lower in {primary_lower, "gpt-oss-120b"}:
            return primary
        if requested_lower in {fast_lower, "gpt-oss-20b"}:
            return fast
        if requested and requested_lower not in {auto_lower, "gpt-oss-auto"}:
            return TargetModel(
                base_url=self._settings.primary_base_url,
                api_key=self._settings.primary_api_key,
                model=requested,
                lane="passthrough",
            )

        return fast if self._should_use_fast_model(request_payload) else primary

    def _should_use_fast_model(self, request_payload: dict[str, Any]) -> bool:
        estimated_tokens = self.estimate_compat_input_tokens(request_payload)
        max_tokens = int(request_payload.get("max_tokens", 4096) or 4096)
        thinking_enabled = self._thinking_enabled(request_payload.get("thinking"))
        complexity_score = 0

        if estimated_tokens >= 10_000:
            complexity_score += 3
        elif estimated_tokens >= 6_000:
            complexity_score += 2
        elif estimated_tokens >= 3_000:
            complexity_score += 1

        if max_tokens >= 8_000:
            complexity_score += 2
        elif max_tokens >= 4_000:
            complexity_score += 1

        if thinking_enabled:
            complexity_score += 1

        for message in request_payload.get("messages", []) or []:
            content = message.get("content") if isinstance(message, dict) else None
            complexity_score += self._content_complexity_score(content)

        return complexity_score < 3

    def _content_complexity_score(self, content: Any) -> int:
        if isinstance(content, str):
            return self._text_complexity_score(content)
        if not isinstance(content, list):
            return 0

        score = 0
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = str(block.get("type", "")).strip().lower()
            if block_type == "tool_result":
                score += 2
                score += self._text_complexity_score(
                    self._normalize_tool_result_content(block.get("content"))
                )
            elif block_type == "tool_use":
                score += 1
            elif block_type in {"thinking", "redacted_thinking", "text"}:
                score += self._text_complexity_score(
                    str(block.get("thinking", "") or block.get("text", ""))
                )
        return score

    def _text_complexity_score(self, text: str) -> int:
        lowered = text.lower()
        score = 0
        if len(text) >= 5_000:
            score += 2
        elif len(text) >= 2_000:
            score += 1

        if re.search(
            r"\b(plan|architecture|refactor|investigate|debug|analyze|benchmark|review|trace|root cause)\b",
            lowered,
        ):
            score += 1
        return score

    def _normalize_system_prompt(self, system_prompt: Any) -> str:
        return self._normalize_content(system_prompt).strip()

    def _normalize_compat_message(
        self,
        message: Any,
    ) -> dict[str, str] | None:
        if not isinstance(message, dict):
            return None
        role = str(message.get("role", "user")).strip().lower()
        if role not in {"system", "user", "assistant"}:
            role = "user"
        content = self._normalize_content(message.get("content"))
        if not content.strip():
            return None
        return {
            "role": role,
            "content": content,
        }

    def _normalize_content(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""

        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = str(block.get("type", "")).strip().lower()
            if block_type == "text":
                text = str(block.get("text", ""))
                if text:
                    parts.append(text)
                continue
            if block_type in {"thinking", "redacted_thinking"}:
                thinking = str(block.get("thinking", "")).strip()
                if thinking:
                    parts.append(f"<prior_thinking>{thinking}</prior_thinking>")
                continue
            if block_type == "tool_use":
                tool_name = str(block.get("name", "")).strip()
                tool_id = str(block.get("id", "")).strip()
                tool_input = json.dumps(
                    block.get("input", {}) or {},
                    separators=(",", ":"),
                )
                parts.append(
                    f'<assistant_tool_call name="{tool_name}" id="{tool_id}">{tool_input}</assistant_tool_call>'
                )
                continue
            if block_type == "tool_result":
                tool_use_id = str(block.get("tool_use_id", "")).strip()
                is_error = "true" if block.get("is_error") else "false"
                result_content = self._normalize_tool_result_content(
                    block.get("content")
                )
                parts.append(
                    f'<tool_result tool_use_id="{tool_use_id}" is_error="{is_error}">{result_content}</tool_result>'
                )
                continue
        return "\n\n".join(part for part in parts if part)

    def _normalize_tool_result_content(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    text_parts.append(item)
                elif isinstance(item, dict):
                    item_type = str(item.get("type", "")).strip().lower()
                    if item_type == "text":
                        text_parts.append(str(item.get("text", "")))
                    elif item_type == "image":
                        text_parts.append("[image omitted]")
            return "\n".join(part for part in text_parts if part)
        return json.dumps(content, ensure_ascii=False)

    async def _run_secondary_processor(
        self,
        config: SecondaryProcessorConfig,
    ) -> list[ParsedEvent]:
        if not config.endpoint:
            return []
        payload = {
            "model": config.model or self._settings.secondary_model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a post-processor for a coding agent. Summarize the prior reasoning into one terse operator note inside a <thinking> tag.",
                }
            ],
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self._settings.secondary_api_key:
            headers["Authorization"] = (
                f"Bearer {self._settings.secondary_api_key}"
            )
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{config.endpoint.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        message = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not message:
            return []
        return [ParsedEvent("delta.thinking", {"delta": f"\n[secondary]\n{message}"})]

    async def _probe_target(self, target: TargetModel) -> dict[str, Any]:
        headers = {}
        if target.api_key:
            headers["Authorization"] = f"Bearer {target.api_key}"

        models_url = f"{target.base_url.rstrip('/')}/models"
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.healthcheck_timeout_seconds,
            ) as client:
                response = await client.get(models_url, headers=headers)
                response.raise_for_status()
                payload = response.json()
        except Exception as error:
            return await self._probe_target_via_completion(target, headers, str(error))

        model_ids = []
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            for item in payload["data"]:
                if isinstance(item, dict) and item.get("id"):
                    model_ids.append(str(item["id"]))

        requested_lower = target.model.lower()
        model_available = not model_ids or any(
            candidate.lower() == requested_lower
            or candidate.lower().endswith(requested_lower)
            or requested_lower.endswith(candidate.lower())
            for candidate in model_ids
        )
        return {
            "ok": model_available,
            "lane": target.lane,
            "model": target.model,
            "base_url": target.base_url,
            "models_listed": model_ids[:50],
            "model_available": model_available,
        }

    async def _probe_target_via_completion(
        self,
        target: TargetModel,
        headers: dict[str, str],
        prior_error: str,
    ) -> dict[str, Any]:
        payload = {
            "model": target.model,
            "stream": False,
            "max_tokens": 1,
            "temperature": 0,
            "messages": [
                {
                    "role": "user",
                    "content": "ping",
                }
            ],
        }
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.healthcheck_timeout_seconds,
            ) as client:
                response = await client.post(
                    f"{target.base_url.rstrip('/')}/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        **headers,
                    },
                    json=payload,
                )
                response.raise_for_status()
        except Exception as error:
            return {
                "ok": False,
                "lane": target.lane,
                "model": target.model,
                "base_url": target.base_url,
                "error": f"models probe failed: {prior_error}; completion probe failed: {error}",
            }

        return {
            "ok": True,
            "lane": target.lane,
            "model": target.model,
            "base_url": target.base_url,
            "probe": "chat.completions",
            "model_available": True,
        }


# Backward-compatible alias while the module path still says glm_backend.
OpenAICompatibleGLMBackend = OpenAICompatibleReasoningBackend
