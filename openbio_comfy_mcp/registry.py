"""Advertise this ComfyUI process through a local, expiring registration file."""

from __future__ import annotations

import asyncio
import atexit
import ipaddress
import json
import logging
import os
import time
import uuid
from contextlib import suppress
from pathlib import Path

HEARTBEAT_INTERVAL = 5.0
INSTANCE_ID = str(uuid.uuid4())
logger = logging.getLogger(__name__)


def local_base_url(address: str, port: int, *, tls: bool = False) -> str | None:
    if address in ("", "localhost"):
        address = "127.0.0.1"
    try:
        host = ipaddress.ip_address(address)
    except ValueError:
        return None
    if host.is_unspecified:
        host = ipaddress.ip_address("::1" if host.version == 6 else "127.0.0.1")
    if not host.is_loopback:
        return None
    hostname = f"[{host}]" if host.version == 6 else str(host)
    return f"{'https' if tls else 'http'}://{hostname}:{port}"


class InstanceRegistration:
    def __init__(self, prompt_server, *, tls: bool = False) -> None:
        self.instance_id = INSTANCE_ID
        self._server = prompt_server
        self._tls = tls
        directory = Path(os.environ.get(
            "OPENBIO_COMFY_REGISTRY_DIR", Path.home() / ".openbio-comfy-mcp" / "instances",
        ))
        self._path = directory / f"{self.instance_id}.json"
        self._temporary_path = self._path.with_suffix(".tmp")

    async def cleanup_ctx(self, app):
        # ComfyUI's command-line shutdown does not call AppRunner.cleanup().
        atexit.register(self._remove)
        task = asyncio.create_task(self._refresh())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            self._remove()
            atexit.unregister(self._remove)

    async def _refresh(self) -> None:
        while True:
            # Native PromptServer sets address/port only after its site starts.
            address = getattr(self._server, "address", None)
            if address is not None:
                base_url = local_base_url(address, self._server.port, tls=self._tls)
                if base_url is None:
                    logger.info("Local ComfyUI discovery requires a loopback or wildcard listener.")
                    return
                record = {
                    "instance_id": self.instance_id,
                    "base_url": base_url,
                    "pid": os.getpid(),
                    "updated_at": time.time(),
                    "name": f"ComfyUI :{self._server.port}",
                }
                try:
                    self._path.parent.mkdir(parents=True, exist_ok=True)
                    self._temporary_path.write_text(json.dumps(record), encoding="utf-8")
                    self._temporary_path.replace(self._path)
                except OSError:
                    logger.warning("Could not register local ComfyUI instance at %s", self._path, exc_info=True)
            await asyncio.sleep(HEARTBEAT_INTERVAL)

    def _remove(self) -> None:
        for path in (self._path, self._temporary_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove local ComfyUI registration at %s", path, exc_info=True)
