from __future__ import annotations

from dataclasses import dataclass
import json
import re

from .schemas import ToolManifestEntry


@dataclass
class ParsedEvent:
    type: str
    payload: dict[str, object]


TOOL_OPEN_RE = re.compile(
    r'^<tool_call\s+name="(?P<name>[^"]+)"\s+id="(?P<id>[^"]+)">',
)


def build_protocol_prompt(tool_manifest: list[ToolManifestEntry]) -> str:
    return build_protocol_prompt_with_options(tool_manifest)


def build_protocol_prompt_with_options(
    tool_manifest: list[ToolManifestEntry],
    *,
    allow_thinking: bool = True,
    forced_tool_name: str | None = None,
) -> str:
    tool_lines = []
    for tool in tool_manifest:
        tool_lines.append(
            f"- {tool.name}: {tool.description}\n"
            f"  JSON schema: {json.dumps(tool.input_schema, separators=(',', ':'))}"
        )

    tool_catalog = "\n".join(tool_lines) if tool_lines else "- No tools available"
    thinking_rule = (
        "- Emit zero or more <thinking> blocks.\n"
        if allow_thinking
        else "- Do not emit <thinking> blocks.\n"
    )
    force_tool_rule = (
        f'- You must emit exactly one <tool_call name="{forced_tool_name}" ...> before any final answer.\n'
        if forced_tool_name
        else ""
    )
    allowed_tags = [
        "<final>user-visible answer text</final>",
        '<tool_call name="ToolName" id="call_unique">{strict JSON args}</tool_call>',
    ]
    if allow_thinking:
        allowed_tags.insert(0, "<thinking>hidden reasoning for the local UI</thinking>")
    allowed_tags_text = "\n".join(
        f"{index}. {tag}" for index, tag in enumerate(allowed_tags, start=1)
    )

    return (
        "You are the remote planning model behind a local Claude-style coding assistant.\n"
        "This bridge is typically backed by OpenAI gpt-oss class models.\n"
        "Respond using only the bridge protocol tags below.\n\n"
        + "Allowed tags:\n"
        + allowed_tags_text
        + "\n\n"
        + "Rules:\n"
        + thinking_rule
        + "- Emit either one <final> block, one or more <tool_call> blocks, or both.\n"
        + "- Do not use markdown fences inside tool_call blocks.\n"
        + "- Tool arguments must be valid JSON.\n"
        + "- Never invent a tool that is not in the catalog.\n\n"
        + force_tool_rule
        + f"Tool catalog:\n{tool_catalog}\n"
    )


class BridgeStreamParser:
    def __init__(self) -> None:
        self._mode = "outside"
        self._buffer = ""
        self._closing_tag = ""
        self._current_tool_name = ""
        self._current_tool_id = ""

    def feed(self, chunk: str) -> list[ParsedEvent]:
        if not chunk:
            return []
        self._buffer += chunk
        events: list[ParsedEvent] = []

        while True:
            if self._mode == "outside":
                next_tag = self._next_open_tag()
                if next_tag is None:
                    break
                open_tag, offset = next_tag
                self._buffer = self._buffer[offset + len(open_tag) :]
                if open_tag == "<thinking>":
                    self._mode = "thinking"
                    self._closing_tag = "</thinking>"
                    continue
                if open_tag == "<final>":
                    self._mode = "final"
                    self._closing_tag = "</final>"
                    continue
                match = TOOL_OPEN_RE.match(open_tag)
                if match:
                    self._mode = "tool"
                    self._closing_tag = "</tool_call>"
                    self._current_tool_name = match.group("name")
                    self._current_tool_id = match.group("id")
                    continue
                break

            closing_idx = self._buffer.find(self._closing_tag)
            if closing_idx >= 0:
                body = self._buffer[:closing_idx]
                events.extend(self._emit_body(body, final_chunk=True))
                self._buffer = self._buffer[closing_idx + len(self._closing_tag) :]
                self._mode = "outside"
                self._closing_tag = ""
                self._current_tool_name = ""
                self._current_tool_id = ""
                continue

            safe_tail = len(self._closing_tag)
            if len(self._buffer) <= safe_tail:
                break
            body = self._buffer[:-safe_tail]
            self._buffer = self._buffer[-safe_tail:]
            events.extend(self._emit_body(body, final_chunk=False))
            break

        return events

    def flush(self) -> list[ParsedEvent]:
        if self._mode == "outside":
            return []
        events = self._emit_body(self._buffer, final_chunk=True)
        self._buffer = ""
        self._mode = "outside"
        self._closing_tag = ""
        self._current_tool_name = ""
        self._current_tool_id = ""
        return events

    def _next_open_tag(self) -> tuple[str, int] | None:
        candidates: list[tuple[int, str]] = []
        for tag in ("<thinking>", "<final>"):
            idx = self._buffer.find(tag)
            if idx >= 0:
                candidates.append((idx, tag))

        tool_match = re.search(
            r'<tool_call\s+name="[^"]+"\s+id="[^"]+">',
            self._buffer,
        )
        if tool_match:
            candidates.append((tool_match.start(), tool_match.group(0)))

        if not candidates:
            return None
        _, tag = min(candidates, key=lambda item: item[0])
        offset = self._buffer.find(tag)
        return tag, offset

    def _emit_body(self, body: str, final_chunk: bool) -> list[ParsedEvent]:
        if not body:
            return []
        if self._mode == "thinking":
            return [ParsedEvent("delta.thinking", {"delta": body})]
        if self._mode == "final":
            return [ParsedEvent("delta.output_text", {"delta": body})]
        if self._mode == "tool":
            if not final_chunk:
                return []
            payload = json.loads(body)
            return [
                ParsedEvent(
                    "tool.call",
                    {
                        "id": self._current_tool_id,
                        "name": self._current_tool_name,
                        "input": payload,
                    },
                )
            ]
        return []
