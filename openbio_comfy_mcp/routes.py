"""HTTP interface for the live-canvas relay."""

from __future__ import annotations

import ipaddress
from typing import Any

from aiohttp import web

from .relay import (
    COMMAND_ROUTE,
    HEALTH_ROUTE,
    REPLY_ROUTE,
    SESSION_ROUTE,
    Relay,
    RelayError,
)


def is_loopback_address(address: str | None) -> bool:
    if address is None:
        return False
    try:
        return ipaddress.ip_address(address.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _error_response(
    *,
    code: str,
    message: str,
    status: int,
    details: dict[str, Any] | None = None,
) -> web.Response:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return web.json_response({"ok": False, "error": error}, status=status)


class RelayAPI:
    def __init__(self, relay: Relay, *, command_timeout: float = 10.0) -> None:
        self._relay = relay
        self._command_timeout = command_timeout

    def register(self, routes: web.RouteTableDef) -> None:
        routes.post(SESSION_ROUTE)(self.session)
        routes.post(COMMAND_ROUTE)(self.command)
        routes.post(REPLY_ROUTE)(self.reply)
        routes.get(HEALTH_ROUTE)(self.health)

    async def session(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            self._relay.register_session(
                page_id=body["page_id"],
                client_id=body["client_id"],
                canvas_id=body["canvas_id"],
                workflow_id=body.get("workflow_id"),
                focused=body.get("focused") is True,
                href=body.get("href"),
            )
        except (KeyError, TypeError, ValueError):
            return _error_response(
                code="INVALID_REQUEST",
                message="Session registration is missing required fields.",
                status=400,
            )
        return web.json_response({"ok": True})

    async def command(self, request: web.Request) -> web.Response:
        if not is_loopback_address(request.remote):
            return _error_response(
                code="FORBIDDEN",
                message="Canvas commands are accepted from loopback only.",
                status=403,
            )
        try:
            body = await request.json()
            result = await self._relay.command(
                canvas_id=body.get("canvas_id"),
                command=body["command"],
                arguments=body["arguments"],
                timeout=self._command_timeout,
            )
        except (KeyError, TypeError, ValueError):
            return _error_response(
                code="INVALID_REQUEST",
                message="Command is missing required fields.",
                status=400,
            )
        except RelayError as error:
            status = 504 if error.code == "CANVAS_TIMEOUT" else 409
            return _error_response(
                code=error.code,
                message=error.message,
                details=error.details,
                status=status,
            )
        return web.json_response({"ok": True, "result": result})

    async def reply(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            accepted = self._relay.receive_reply(
                page_id=body["page_id"],
                request_id=body["request_id"],
                ok=body["ok"],
                result=body.get("result"),
                error=body.get("error"),
            )
        except (KeyError, TypeError, ValueError):
            return _error_response(
                code="INVALID_REQUEST",
                message="Reply is missing required fields.",
                status=400,
            )
        if not accepted:
            return _error_response(
                code="UNKNOWN_REQUEST",
                message="No pending command matches this reply.",
                status=404,
            )
        return web.json_response({"ok": True})

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True})
