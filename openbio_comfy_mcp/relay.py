"""Relay commands between a local MCP host and a live ComfyUI page."""

from __future__ import annotations

import asyncio
import inspect
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

COMMAND_EVENT = "openbio-comfy-mcp:command"
SESSION_ROUTE = "/openbio-comfy-mcp/session"
COMMAND_ROUTE = "/openbio-comfy-mcp/command"
REPLY_ROUTE = "/openbio-comfy-mcp/reply"
HEALTH_ROUTE = "/openbio-comfy-mcp/health"

SendEvent = Callable[[str, dict[str, Any], str], Awaitable[None] | None]
Clock = Callable[[], float]
ClientConnectionCheck = Callable[[str], bool]


class RelayError(Exception):
    """A stable relay error suitable for returning as JSON."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


@dataclass(slots=True)
class _Session:
    page_id: str
    client_id: str
    canvas_id: str
    workflow_id: str | None
    focused: bool
    href: str | None
    last_seen: float


@dataclass(slots=True)
class _PendingRequest:
    page_id: str
    future: asyncio.Future[Any]


class Relay:
    """Route one command to the selected live page and correlate its reply."""

    def __init__(
        self,
        send_event: SendEvent,
        *,
        session_ttl: float = 15.0,
        clock: Clock = time.monotonic,
        is_client_connected: ClientConnectionCheck | None = None,
    ) -> None:
        self._send_event = send_event
        self._session_ttl = session_ttl
        self._clock = clock
        self._is_client_connected = is_client_connected or (lambda client_id: True)
        self._sessions: dict[str, _Session] = {}
        self._pending: dict[str, _PendingRequest] = {}

    def register_session(
        self,
        *,
        page_id: str,
        client_id: str,
        canvas_id: str,
        workflow_id: str | None,
        focused: bool,
        href: str | None,
    ) -> None:
        self._sessions[page_id] = _Session(
            page_id=page_id,
            client_id=client_id,
            canvas_id=canvas_id,
            workflow_id=workflow_id,
            focused=focused,
            href=href,
            last_seen=self._clock(),
        )

    async def command(
        self,
        *,
        command: str,
        arguments: dict[str, Any],
        canvas_id: str | None = None,
        timeout: float = 10.0,
    ) -> Any:
        session = self._select_session(canvas_id)
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = _PendingRequest(session.page_id, future)
        payload = {
            "request_id": request_id,
            "command": command,
            "arguments": arguments,
            "page_id": session.page_id,
            "workflow_id": session.workflow_id,
            "canvas_id": session.canvas_id,
        }

        try:
            sent = self._send_event(COMMAND_EVENT, payload, session.client_id)
            if inspect.isawaitable(sent):
                await sent
            return await asyncio.wait_for(future, timeout)
        except TimeoutError as error:
            raise RelayError(
                "CANVAS_TIMEOUT",
                "The live canvas did not reply in time.",
            ) from error
        finally:
            self._pending.pop(request_id, None)

    def _select_session(self, canvas_id: str | None) -> _Session:
        now = self._clock()
        self._sessions = {
            page_id: session
            for page_id, session in self._sessions.items()
            if now - session.last_seen <= self._session_ttl
            and self._is_client_connected(session.client_id)
        }
        if canvas_id is not None:
            matches = [
                session
                for session in self._sessions.values()
                if session.canvas_id == canvas_id
            ]
            if len(matches) == 1:
                return matches[0]
            if not matches:
                raise RelayError(
                    "NO_LIVE_CANVAS",
                    "No live ComfyUI canvas is connected.",
                    details={"canvas_id": canvas_id},
                )

        if not self._sessions:
            raise RelayError(
                "NO_LIVE_CANVAS",
                "No live ComfyUI canvas is connected.",
            )
        if len(self._sessions) == 1:
            return next(iter(self._sessions.values()))
        focused = [session for session in self._sessions.values() if session.focused]
        if len(focused) == 1:
            return focused[0]
        raise RelayError(
            "AMBIGUOUS_LIVE_CANVAS",
            "More than one live ComfyUI canvas is connected.",
            details={
                "canvas_ids": sorted(
                    session.canvas_id for session in self._sessions.values()
                )
            },
        )

    def receive_reply(
        self,
        *,
        page_id: str,
        request_id: str,
        ok: bool,
        result: Any = None,
        error: dict[str, Any] | None = None,
    ) -> bool:
        pending = self._pending.get(request_id)
        if pending is None or pending.page_id != page_id:
            return False
        if ok:
            pending.future.set_result(result)
        else:
            assert error is not None
            pending.future.set_exception(
                RelayError(
                    error["code"],
                    error["message"],
                    details=error.get("details"),
                )
            )
        return True
