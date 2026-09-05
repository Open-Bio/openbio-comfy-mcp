import asyncio
import importlib
import importlib.util
import json
import sys
import types
from pathlib import Path

from aiohttp import web


def test_v3_extension_registers_relay_routes_sends_native_events_and_has_no_nodes(
    monkeypatch,
):
    class ComfyExtension:
        pass

    comfy_api = types.ModuleType("comfy_api")
    comfy_api_latest = types.ModuleType("comfy_api.latest")
    comfy_api_latest.ComfyExtension = ComfyExtension
    monkeypatch.setitem(sys.modules, "comfy_api", comfy_api)
    monkeypatch.setitem(sys.modules, "comfy_api.latest", comfy_api_latest)

    class Routes:
        def __init__(self):
            self.handlers = {}

        def _register(self, method, path):
            def decorator(handler):
                self.handlers[(method, path)] = handler
                return handler

            return decorator

        def post(self, path):
            return self._register("POST", path)

        def get(self, path):
            return self._register("GET", path)

    class ServerInstance:
        def __init__(self):
            self.app = web.Application()
            self.routes = Routes()
            self.events = []
            self.sockets = {"client-a": object()}

        async def send(self, event, data, sid):
            self.events.append((event, data, sid))

    server_instance = ServerInstance()
    server_module = types.ModuleType("server")
    server_module.PromptServer = types.SimpleNamespace(instance=server_instance)
    server_module.args = types.SimpleNamespace(tls_keyfile=None, tls_certfile=None)
    monkeypatch.setitem(sys.modules, "server", server_module)
    sys.modules.pop("openbio_comfy_mcp.extension", None)
    extension_module = importlib.import_module("openbio_comfy_mcp.extension")

    class Request:
        remote = "127.0.0.1"

        def __init__(self, body):
            self._body = body

        async def json(self):
            return self._body

    async def exercise():
        extension = extension_module.OpenBioComfyMcpExtension()
        await extension.on_load()
        assert await extension.get_node_list() == []
        assert len(server_instance.app.cleanup_ctx) == 1
        health = await server_instance.routes.handlers[
            ("GET", "/openbio-comfy-mcp/health")
        ](Request({}))
        assert json.loads(health.text) == {
            "ok": True,
            "instance_id": extension._registration.instance_id,
            "canvases": [],
        }
        assert set(server_instance.routes.handlers) == {
            ("POST", "/openbio-comfy-mcp/session"),
            ("POST", "/openbio-comfy-mcp/command"),
            ("POST", "/openbio-comfy-mcp/reply"),
            ("GET", "/openbio-comfy-mcp/health"),
        }

        await server_instance.routes.handlers[
            ("POST", "/openbio-comfy-mcp/session")
        ](
            Request(
                {
                    "page_id": "page-a",
                    "client_id": "client-a",
                    "canvas_id": "canvas-a",
                    "workflow_id": "workflow-a",
                    "focused": True,
                    "href": "http://127.0.0.1:8188/#a",
                }
            )
        )
        command_task = asyncio.create_task(
            server_instance.routes.handlers[
                ("POST", "/openbio-comfy-mcp/command")
            ](
                Request(
                    {
                        "instance_id": extension._registration.instance_id,
                        "canvas_id": "canvas-a",
                        "command": "inspect_canvas",
                        "arguments": {},
                    }
                )
            )
        )
        while not server_instance.events:
            await asyncio.sleep(0)
        event, payload, sid = server_instance.events[0]
        assert event == "openbio-comfy-mcp:command"
        assert sid == "client-a"

        await server_instance.routes.handlers[
            ("POST", "/openbio-comfy-mcp/reply")
        ](
            Request(
                {
                    "page_id": "page-a",
                    "request_id": payload["request_id"],
                    "ok": True,
                    "result": {"revision": "2"},
                }
            )
        )
        response = await command_task
        assert json.loads(response.text) == {
            "ok": True,
            "result": {"revision": "2"},
            "instance_id": extension._registration.instance_id,
        }

        plugin_root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location(
            "openbio_comfy_mcp_plugin",
            plugin_root / "__init__.py",
            submodule_search_locations=[str(plugin_root)],
        )
        assert spec is not None and spec.loader is not None
        plugin_module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, plugin_module)
        spec.loader.exec_module(plugin_module)
        assert plugin_module.WEB_DIRECTORY == "./web"
        entrypoint = await plugin_module.comfy_entrypoint()
        assert entrypoint.__class__.__name__ == "OpenBioComfyMcpExtension"
        assert await entrypoint.get_node_list() == []

    asyncio.run(exercise())
