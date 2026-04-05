from __future__ import annotations

from datetime import UTC, datetime
import json
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse, StreamingResponse

from .config import load_settings
from .glm_backend import OpenAICompatibleReasoningBackend
from .protocol import ParsedEvent
from .schemas import (
    ClientEnvelope,
    ServerEnvelope,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionStateResponse,
    TurnRequest,
)
from .session_store import SessionStore


settings = load_settings()
store = SessionStore()
backend = OpenAICompatibleReasoningBackend(settings)
app = FastAPI(title="Remote GPT-OSS Bridge", version="0.2.0")


def _validate_token(token: str | None) -> None:
    if not settings.bridge_api_keys:
        return
    if token in settings.bridge_api_keys:
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid bridge token",
    )


def _extract_token(
    authorization: str | None,
    x_api_key: str | None,
) -> str | None:
    if x_api_key:
        return x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    return None


async def require_auth(
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header(alias="X-Api-Key")] = None,
) -> None:
    _validate_token(_extract_token(authorization, x_api_key))


def _message_envelope(
    *,
    message_id: str,
    model: str,
    content: list[dict[str, object]],
    stop_reason: str,
    input_tokens: int,
    output_tokens: int,
) -> dict[str, object]:
    return {
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    }


def _anthropic_error_response(
    message: str,
    *,
    status_code: int = 500,
) -> JSONResponse:
    return JSONResponse(
        {
            "type": "error",
            "error": {
                "type": "api_error",
                "message": message,
            },
        },
        status_code=status_code,
    )


def _sse_event(event: str, payload: dict[str, object]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _build_message_from_events(
    events: list[ParsedEvent],
) -> tuple[list[dict[str, object]], str]:
    content: list[dict[str, object]] = []
    saw_tool_use = False

    for event in events:
        if event.type == "delta.thinking":
            if content and content[-1]["type"] == "thinking":
                content[-1]["thinking"] = (
                    str(content[-1].get("thinking", "")) + str(event.payload["delta"])
                )
            else:
                content.append(
                    {
                        "type": "thinking",
                        "thinking": str(event.payload["delta"]),
                        "signature": "",
                    }
                )
            continue

        if event.type == "delta.output_text":
            if content and content[-1]["type"] == "text":
                content[-1]["text"] = (
                    str(content[-1].get("text", "")) + str(event.payload["delta"])
                )
            else:
                content.append(
                    {
                        "type": "text",
                        "text": str(event.payload["delta"]),
                    }
                )
            continue

        if event.type == "tool.call":
            saw_tool_use = True
            content.append(
                {
                    "type": "tool_use",
                    "id": str(event.payload["id"]),
                    "name": str(event.payload["name"]),
                    "input": event.payload["input"],
                }
            )

    return content, "tool_use" if saw_tool_use else "end_turn"


def _estimate_output_tokens(content: list[dict[str, object]]) -> int:
    joined = "\n".join(
        json.dumps(block, ensure_ascii=False, separators=(",", ":"))
        for block in content
    )
    return max(1, len(joined) // 4) if joined else 1


async def _stream_anthropic_compat_response(
    payload: dict[str, object],
    *,
    request_id: str,
) -> object:
    model = backend.resolve_compat_model_name(payload)
    input_tokens = backend.estimate_compat_input_tokens(payload)
    message_id = f"msg_{uuid4().hex}"

    async def iterator() -> object:
        current_block_type: str | None = None
        current_index = -1
        saw_tool_use = False
        output_char_count = 0

        yield _sse_event(
            "message_start",
            {
                "type": "message_start",
                "message": _message_envelope(
                    message_id=message_id,
                    model=model,
                    content=[],
                    stop_reason="end_turn",
                    input_tokens=input_tokens,
                    output_tokens=0,
                ),
            },
        )

        try:
            async for event in backend.stream_compat_request(payload):
                if event.type == "delta.thinking":
                    if current_block_type != "thinking":
                        if current_block_type is not None:
                            yield _sse_event(
                                "content_block_stop",
                                {"type": "content_block_stop", "index": current_index},
                            )
                        current_index += 1
                        current_block_type = "thinking"
                        yield _sse_event(
                            "content_block_start",
                            {
                                "type": "content_block_start",
                                "index": current_index,
                                "content_block": {
                                    "type": "thinking",
                                    "thinking": "",
                                    "signature": "",
                                },
                            },
                        )

                    delta = str(event.payload["delta"])
                    output_char_count += len(delta)
                    yield _sse_event(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": current_index,
                            "delta": {
                                "type": "thinking_delta",
                                "thinking": delta,
                            },
                        },
                    )
                    continue

                if event.type == "delta.output_text":
                    if current_block_type != "text":
                        if current_block_type is not None:
                            yield _sse_event(
                                "content_block_stop",
                                {"type": "content_block_stop", "index": current_index},
                            )
                        current_index += 1
                        current_block_type = "text"
                        yield _sse_event(
                            "content_block_start",
                            {
                                "type": "content_block_start",
                                "index": current_index,
                                "content_block": {
                                    "type": "text",
                                    "text": "",
                                },
                            },
                        )

                    delta = str(event.payload["delta"])
                    output_char_count += len(delta)
                    yield _sse_event(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": current_index,
                            "delta": {
                                "type": "text_delta",
                                "text": delta,
                            },
                        },
                    )
                    continue

                if event.type == "tool.call":
                    saw_tool_use = True
                    if current_block_type is not None:
                        yield _sse_event(
                            "content_block_stop",
                            {"type": "content_block_stop", "index": current_index},
                        )
                        current_block_type = None

                    current_index += 1
                    payload_json = json.dumps(
                        event.payload["input"],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    output_char_count += len(payload_json)
                    yield _sse_event(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": current_index,
                            "content_block": {
                                "type": "tool_use",
                                "id": str(event.payload["id"]),
                                "name": str(event.payload["name"]),
                                "input": {},
                            },
                        },
                    )
                    yield _sse_event(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": current_index,
                            "delta": {
                                "type": "input_json_delta",
                                "partial_json": payload_json,
                            },
                        },
                    )
                    yield _sse_event(
                        "content_block_stop",
                        {"type": "content_block_stop", "index": current_index},
                    )
                    continue

            if current_block_type is not None:
                yield _sse_event(
                    "content_block_stop",
                    {"type": "content_block_stop", "index": current_index},
                )

            yield _sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": "tool_use" if saw_tool_use else "end_turn",
                        "stop_sequence": None,
                    },
                    "usage": {
                        "output_tokens": max(1, output_char_count // 4),
                    },
                },
            )
            yield _sse_event(
                "message_stop",
                {
                    "type": "message_stop",
                },
            )
        except Exception as error:
            yield _sse_event(
                "error",
                {
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "message": str(error),
                    },
                },
            )

    return StreamingResponse(
        iterator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "request-id": request_id,
        },
    )


@app.get("/healthz")
async def healthz() -> JSONResponse:
    health = await backend.health_status()
    status_code = status.HTTP_200_OK if health["ready"] else status.HTTP_503_SERVICE_UNAVAILABLE
    return JSONResponse(
        {
            **health,
            "time": datetime.now(UTC).isoformat(),
        },
        status_code=status_code,
    )


@app.post("/v1/messages", dependencies=[Depends(require_auth)], response_model=None)
async def create_compat_message(request: Request) -> Response:
    try:
        payload = await request.json()
    except Exception:
        return _anthropic_error_response("Request body must be valid JSON.", status_code=400)

    if not isinstance(payload, dict):
        return _anthropic_error_response("Request body must be a JSON object.", status_code=400)

    request_id = f"req_{uuid4().hex}"
    if payload.get("stream"):
        return await _stream_anthropic_compat_response(payload, request_id=request_id)

    try:
        events: list[ParsedEvent] = []
        async for event in backend.stream_compat_request(payload):
            events.append(event)
        content, stop_reason = _build_message_from_events(events)
        input_tokens = backend.estimate_compat_input_tokens(payload)
        output_tokens = _estimate_output_tokens(content)
        return JSONResponse(
            _message_envelope(
                message_id=f"msg_{uuid4().hex}",
                model=backend.resolve_compat_model_name(payload),
                content=content,
                stop_reason=stop_reason,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ),
            headers={"request-id": request_id},
        )
    except Exception as error:
        return _anthropic_error_response(str(error))


@app.post("/v1/messages/count_tokens", dependencies=[Depends(require_auth)])
async def count_tokens(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        return _anthropic_error_response("Request body must be valid JSON.", status_code=400)

    if not isinstance(payload, dict):
        return _anthropic_error_response("Request body must be a JSON object.", status_code=400)

    return JSONResponse(
        {
            "input_tokens": backend.estimate_compat_input_tokens(payload),
        }
    )


@app.post("/v1/sessions", dependencies=[Depends(require_auth)])
async def create_session(
    request: SessionCreateRequest,
) -> SessionCreateResponse:
    session = store.create(request)
    return SessionCreateResponse(
        session_id=session.session_id,
        websocket_url=f"/v1/sessions/{session.session_id}/stream",
        expires_at=session.expires_at,
    )


@app.get("/v1/sessions/{session_id}", dependencies=[Depends(require_auth)])
async def get_session(session_id: str) -> SessionStateResponse:
    session = store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionStateResponse(
        session_id=session.session_id,
        session_label=session.session_label,
        user_id=session.user_id,
        created_at=session.created_at,
        updated_at=session.updated_at,
        tool_count=len(session.tool_manifest),
        workspace_id=session.workspace.workspace_id,
    )


@app.websocket("/v1/sessions/{session_id}/stream")
async def stream_session(websocket: WebSocket, session_id: str) -> None:
    token = websocket.query_params.get("token")
    try:
        _validate_token(token)
    except HTTPException:
        await websocket.close(code=4401, reason="Unauthorized")
        return

    session = store.get(session_id)
    if not session:
        await websocket.close(code=4404, reason="Session not found")
        return

    await websocket.accept()
    await websocket.send_json(
        ServerEnvelope(
            type="session.ready",
            payload={"session_id": session_id, "label": session.session_label},
        ).model_dump()
    )

    try:
        while True:
            raw = await websocket.receive_json()
            envelope = ClientEnvelope.model_validate(raw)

            if envelope.type == "session.close":
                await websocket.send_json(
                    ServerEnvelope(type="session.closed", payload={}).model_dump()
                )
                await websocket.close(code=1000)
                return

            if envelope.type == "session.configure":
                if "tool_manifest" in envelope.payload:
                    turn = TurnRequest(
                        turn_id="configure",
                        prompt="",
                        tool_manifest=envelope.payload.get("tool_manifest", []),
                    )
                    if turn.tool_manifest:
                        store.update_tool_manifest(session_id, turn.tool_manifest)
                await websocket.send_json(
                    ServerEnvelope(type="session.configured", payload={}).model_dump()
                )
                continue

            if envelope.type == "tool.result":
                await websocket.send_json(
                    ServerEnvelope(
                        type="tool.result.ack",
                        payload={"tool_use_id": envelope.payload.get("tool_use_id")},
                    ).model_dump()
                )
                continue

            if envelope.type != "turn.start":
                await websocket.send_json(
                    ServerEnvelope(
                        type="error",
                        payload={"message": f"Unsupported event: {envelope.type}"},
                    ).model_dump()
                )
                continue

            turn = TurnRequest.model_validate(envelope.payload)
            if turn.workspace_patch:
                store.update_workspace(session_id, turn.workspace_patch)
            if turn.tool_manifest:
                store.update_tool_manifest(session_id, turn.tool_manifest)

            await websocket.send_json(
                ServerEnvelope(
                    type="turn.started",
                    payload={"turn_id": turn.turn_id},
                ).model_dump()
            )

            try:
                async for event in backend.stream_turn(session, turn):
                    await websocket.send_json(
                        ServerEnvelope(
                            type=event.type,
                            payload={"turn_id": turn.turn_id, **event.payload},
                        ).model_dump()
                    )
                await websocket.send_json(
                    ServerEnvelope(
                        type="turn.completed",
                        payload={"turn_id": turn.turn_id},
                    ).model_dump()
                )
            except Exception as error:  # pragma: no cover - network failures
                await websocket.send_json(
                    ServerEnvelope(
                        type="error",
                        payload={"turn_id": turn.turn_id, "message": str(error)},
                    ).model_dump()
                )
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server.remote_glm_bridge.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
