"""HTTP interface for the live-canvas relay."""

from __future__ import annotations

import ipaddress
from typing import Any

from aiohttp import web

from .prompt import inspect_prompt_queue
from .relay import (
    COMMAND_ROUTE,
    HEALTH_ROUTE,
    PROMPT_ROUTE,
    REPLY_ROUTE,
    SESSION_ROUTE,
    Relay,
    RelayError,
)


def is_local_address(address: str | None) -> bool:
    if address is None:
        return False
    try:
        host = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(host, "ipv4_mapped", None)
    if mapped is not None:
        host = mapped
    return host.is_loopback or host.is_private


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


class _InvalidRequest(Exception):
    pass


async def _json_object(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (ValueError, LookupError) as error:
        raise _InvalidRequest from error
    if not isinstance(body, dict):
        raise _InvalidRequest
    return body


def _required_string(body: dict[str, Any], field: str) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not value:
        raise _InvalidRequest
    return value


def _optional_string(body: dict[str, Any], field: str) -> str | None:
    value = body.get(field)
    if value is not None and not isinstance(value, str):
        raise _InvalidRequest
    return value


def _required_object(body: dict[str, Any], field: str) -> dict[str, Any]:
    value = body.get(field)
    if not isinstance(value, dict):
        raise _InvalidRequest
    return value


class RelayAPI:
    def __init__(
        self,
        relay: Relay,
        *,
        command_timeout: float = 10.0,
        instance_id: str | None = None,
        prompt_queue: Any = None,
        folder_paths: Any = None,
    ) -> None:
        self._relay = relay
        self._command_timeout = command_timeout
        self._instance_id = instance_id
        self._prompt_queue = prompt_queue
        self._folder_paths = folder_paths

    def register(self, routes: web.RouteTableDef) -> None:
        routes.post(SESSION_ROUTE)(self.session)
        routes.post(COMMAND_ROUTE)(self.command)
        routes.post(REPLY_ROUTE)(self.reply)
        routes.get(HEALTH_ROUTE)(self.health)
        routes.get(PROMPT_ROUTE)(self.prompt)

    async def session(self, request: web.Request) -> web.Response:
        try:
            body = await _json_object(request)
            page_id = _required_string(body, "page_id")
            client_id = _required_string(body, "client_id")
            canvas_id = _required_string(body, "canvas_id")
            workflow_id = _optional_string(body, "workflow_id")
            href = _optional_string(body, "href")
            focused = body.get("focused", False)
            if not isinstance(focused, bool):
                raise _InvalidRequest
            last_focused_at = body.get("last_focused_at")
            if last_focused_at is not None and (
                type(last_focused_at) not in (int, float)
                or not 0 <= last_focused_at < float("inf")
            ):
                raise _InvalidRequest
        except _InvalidRequest:
            return _error_response(
                code="INVALID_REQUEST",
                message="Session registration is missing required fields.",
                status=400,
            )
        self._relay.register_session(
            page_id=page_id,
            client_id=client_id,
            canvas_id=canvas_id,
            workflow_id=workflow_id,
            focused=focused,
            href=href,
            last_focused_at=last_focused_at,
        )
        return web.json_response({"ok": True})

    async def command(self, request: web.Request) -> web.Response:
        if not is_local_address(request.remote):
            return _error_response(
                code="FORBIDDEN",
                message="Canvas commands are accepted from loopback and private LAN addresses only.",
                status=403,
            )
        try:
            body = await _json_object(request)
            canvas_id = _required_string(body, "canvas_id") if "canvas_id" in body else None
            instance_id = _required_string(body, "instance_id") if "instance_id" in body else None
            command = _required_string(body, "command")
            arguments = _required_object(body, "arguments")
        except _InvalidRequest:
            return _error_response(
                code="INVALID_REQUEST",
                message="Command is missing required fields.",
                status=400,
            )
        if instance_id is not None and instance_id != self._instance_id:
            return _error_response(
                code="INSTANCE_MISMATCH",
                message="This ComfyUI process does not match the selected instance.",
                status=409,
                details={"instance_id": instance_id},
            )
        try:
            result = await self._relay.command(
                canvas_id=canvas_id,
                command=command,
                arguments=arguments,
                timeout=self._command_timeout,
            )
        except RelayError as error:
            status = 504 if error.code == "CANVAS_TIMEOUT" else 409
            return _error_response(
                code=error.code,
                message=error.message,
                details=error.details,
                status=status,
            )
        return web.json_response({
            "ok": True,
            "result": result,
            **({"instance_id": self._instance_id} if self._instance_id is not None else {}),
        })

    async def reply(self, request: web.Request) -> web.Response:
        try:
            body = await _json_object(request)
            page_id = _required_string(body, "page_id")
            request_id = _required_string(body, "request_id")
            ok = body.get("ok")
            if not isinstance(ok, bool):
                raise _InvalidRequest
            error = None
            if not ok:
                error = _required_object(body, "error")
                _required_string(error, "code")
                _required_string(error, "message")
                if error.get("details") is not None and not isinstance(error["details"], dict):
                    raise _InvalidRequest
        except _InvalidRequest:
            return _error_response(
                code="INVALID_REQUEST",
                message="Reply is missing required fields.",
                status=400,
            )
        accepted = self._relay.receive_reply(
            page_id=page_id,
            request_id=request_id,
            ok=ok,
            result=body.get("result"),
            error=error,
        )
        if not accepted:
            return _error_response(
                code="UNKNOWN_REQUEST",
                message="No pending command matches this reply.",
                status=404,
            )
        return web.json_response({"ok": True})

    def _prompt_lookup(self) -> tuple[Any, Any]:
        queue = self._prompt_queue
        folder_paths = self._folder_paths
        if queue is None:
            from server import PromptServer

            queue = PromptServer.instance.prompt_queue
        if folder_paths is None:
            import folder_paths as folder_paths_module

            folder_paths = folder_paths_module
        return queue, folder_paths

    async def prompt(self, request: web.Request) -> web.Response:
        if not is_local_address(request.remote):
            return _error_response(
                code="FORBIDDEN",
                message="Prompt status is accepted from loopback and private LAN addresses only.",
                status=403,
            )
        prompt_id = request.match_info.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id:
            return _error_response(
                code="INVALID_REQUEST",
                message="Prompt status requires a prompt_id.",
                status=400,
            )
        queue, folder_paths = self._prompt_lookup()
        result = inspect_prompt_queue(
            prompt_id,
            queue=queue,
            folder_paths=folder_paths,
        )
        return web.json_response({
            "ok": True,
            "result": result,
            **({"instance_id": self._instance_id} if self._instance_id is not None else {}),
        })

    async def health(self, request: web.Request) -> web.Response:
        if self._instance_id is not None and is_local_address(request.remote):
            return web.json_response({
                "ok": True,
                "instance_id": self._instance_id,
                "canvases": self._relay.list_canvases(),
            })
        return web.json_response({"ok": True})
