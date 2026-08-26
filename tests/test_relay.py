import asyncio
import json

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from openbio_comfy_mcp.relay import COMMAND_EVENT, Relay, RelayError
from openbio_comfy_mcp.routes import RelayAPI


def test_single_registered_page_receives_a_correlated_command_and_reply():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((event, data, sid)))
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id="workflow-a",
        focused=True,
        href="http://127.0.0.1:8188/#workflow-a",
    )

    async def exercise():
        pending = asyncio.create_task(
            relay.command(
                command="inspect_canvas",
                arguments={},
                timeout=0.1,
            )
        )
        await asyncio.sleep(0)

        assert len(sent) == 1
        event, payload, sid = sent[0]
        assert event == COMMAND_EVENT
        assert sid == "client-a"
        assert payload == {
            "request_id": payload["request_id"],
            "command": "inspect_canvas",
            "arguments": {},
            "page_id": "page-a",
            "workflow_id": "workflow-a",
            "canvas_id": "canvas-a",
        }

        relay.receive_reply(
            page_id="page-a",
            request_id=payload["request_id"],
            ok=True,
            result={"revision": "7"},
        )
        assert await pending == {"revision": "7"}

    asyncio.run(exercise())


def test_command_without_a_registered_page_reports_no_live_canvas():
    relay = Relay(send_event=lambda event, data, sid: None)

    async def exercise():
        try:
            await relay.command(command="inspect_canvas", arguments={})
        except RelayError as error:
            assert error.code == "NO_LIVE_CANVAS"
            assert error.message == "No live ComfyUI canvas is connected."
        else:
            raise AssertionError("command should fail without a live canvas")

    asyncio.run(exercise())


def test_disconnected_websocket_is_not_treated_as_a_live_canvas():
    connected = {"client-a"}
    sent = []
    relay = Relay(
        send_event=lambda event, data, sid: sent.append((data, sid)),
        is_client_connected=lambda client_id: client_id in connected,
    )
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id="workflow-a",
        focused=True,
        href=None,
    )
    connected.clear()

    async def exercise():
        try:
            await relay.command(command="inspect_canvas", arguments={})
        except RelayError as error:
            assert error.code == "NO_LIVE_CANVAS"
        else:
            raise AssertionError("a closed websocket should not remain live until TTL expiry")

    asyncio.run(exercise())
    assert sent == []


def test_exact_canvas_routes_to_the_matching_session():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((data, sid)))
    relay.register_session(
        page_id="page-a",
        client_id="client-old",
        canvas_id="canvas-a",
        workflow_id="workflow-a",
        focused=False,
        href="http://127.0.0.1:8188/#a",
    )
    relay.register_session(
        page_id="page-b",
        client_id="client-b",
        canvas_id="canvas-b",
        workflow_id="workflow-b",
        focused=True,
        href="http://127.0.0.1:8188/#b",
    )
    relay.register_session(
        page_id="page-a",
        client_id="client-new",
        canvas_id="canvas-a",
        workflow_id="workflow-a2",
        focused=True,
        href="http://127.0.0.1:8188/#a2",
    )

    async def exercise():
        pending = asyncio.create_task(
            relay.command(
                canvas_id="canvas-b",
                command="inspect_canvas",
                arguments={},
                timeout=0.1,
            )
        )
        await asyncio.sleep(0)
        payload, sid = sent[0]
        assert sid == "client-b"
        assert payload["workflow_id"] == "workflow-b"
        relay.receive_reply(
            page_id="page-b",
            request_id=payload["request_id"],
            ok=True,
            result={"canvas_id": "canvas-b"},
        )
        assert await pending == {"canvas_id": "canvas-b"}

    asyncio.run(exercise())


def test_multiple_pages_route_to_the_only_focused_page():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((data, sid)))
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=False,
        href=None,
    )
    relay.register_session(
        page_id="page-b",
        client_id="client-b",
        canvas_id="canvas-b",
        workflow_id=None,
        focused=True,
        href=None,
    )

    async def exercise():
        pending = asyncio.create_task(
            relay.command(command="inspect_canvas", arguments={}, timeout=0.1)
        )
        await asyncio.sleep(0)
        payload, sid = sent[0]
        assert sid == "client-b"
        relay.receive_reply(
            page_id="page-b",
            request_id=payload["request_id"],
            ok=True,
            result={"canvas_id": "canvas-b"},
        )
        assert await pending == {"canvas_id": "canvas-b"}

    asyncio.run(exercise())


def test_multiple_unfocused_pages_report_ambiguity_instead_of_guessing():
    relay = Relay(send_event=lambda event, data, sid: None)
    for suffix in ("a", "b"):
        relay.register_session(
            page_id=f"page-{suffix}",
            client_id=f"client-{suffix}",
            canvas_id=f"canvas-{suffix}",
            workflow_id=None,
            focused=False,
            href=None,
        )

    async def exercise():
        try:
            await relay.command(command="inspect_canvas", arguments={})
        except RelayError as error:
            assert error.code == "AMBIGUOUS_LIVE_CANVAS"
            assert error.details == {"canvas_ids": ["canvas-a", "canvas-b"]}
        else:
            raise AssertionError("command should not guess between live canvases")

    asyncio.run(exercise())


def test_heartbeat_refreshes_a_session_until_it_expires():
    now = [100.0]
    sent = []
    relay = Relay(
        send_event=lambda event, data, sid: sent.append((data, sid)),
        session_ttl=5.0,
        clock=lambda: now[0],
    )
    registration = {
        "page_id": "page-a",
        "client_id": "client-a",
        "canvas_id": "canvas-a",
        "workflow_id": None,
        "focused": True,
        "href": None,
    }
    relay.register_session(**registration)
    now[0] = 104.0
    relay.register_session(**registration)

    async def exercise():
        now[0] = 108.0
        pending = asyncio.create_task(
            relay.command(command="inspect_canvas", arguments={}, timeout=0.1)
        )
        await asyncio.sleep(0)
        payload, _ = sent[0]
        relay.receive_reply(
            page_id="page-a",
            request_id=payload["request_id"],
            ok=True,
            result={},
        )
        assert await pending == {}

        now[0] = 110.0
        try:
            await relay.command(command="inspect_canvas", arguments={})
        except RelayError as error:
            assert error.code == "NO_LIVE_CANVAS"
        else:
            raise AssertionError("expired session should not remain live")

    asyncio.run(exercise())


def test_reply_must_match_both_request_and_page():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append(data))
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=True,
        href=None,
    )

    async def exercise():
        pending = asyncio.create_task(
            relay.command(command="inspect_canvas", arguments={}, timeout=0.1)
        )
        await asyncio.sleep(0)
        request_id = sent[0]["request_id"]
        relay.receive_reply(
            page_id="different-page",
            request_id=request_id,
            ok=True,
            result={"wrong": True},
        )
        await asyncio.sleep(0)
        assert not pending.done()
        relay.receive_reply(
            page_id="page-a",
            request_id=request_id,
            ok=True,
            result={"right": True},
        )
        assert await pending == {"right": True}

    asyncio.run(exercise())


def test_page_error_is_returned_to_the_command_caller():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append(data))
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=True,
        href=None,
    )

    async def exercise():
        pending = asyncio.create_task(
            relay.command(command="apply_canvas_patch", arguments={}, timeout=0.1)
        )
        await asyncio.sleep(0)
        relay.receive_reply(
            page_id="page-a",
            request_id=sent[0]["request_id"],
            ok=False,
            error={
                "code": "STALE_CANVAS",
                "message": "Canvas revision changed.",
                "details": {"actual_revision": "8"},
            },
        )
        try:
            await pending
        except RelayError as error:
            assert error.code == "STALE_CANVAS"
            assert error.message == "Canvas revision changed."
            assert error.details == {"actual_revision": "8"}
        else:
            raise AssertionError("page error should fail the command")

    asyncio.run(exercise())


def test_command_timeout_has_a_stable_relay_error():
    relay = Relay(send_event=lambda event, data, sid: None)
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=True,
        href=None,
    )

    async def exercise():
        try:
            await relay.command(
                command="inspect_canvas",
                arguments={},
                timeout=0.001,
            )
        except RelayError as error:
            assert error.code == "CANVAS_TIMEOUT"
            assert error.message == "The live canvas did not reply in time."
        else:
            raise AssertionError("command should time out without a page reply")

    asyncio.run(exercise())


def test_http_routes_register_dispatch_and_accept_a_page_reply():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((data, sid)))
    api = RelayAPI(relay, command_timeout=0.1)
    routes = web.RouteTableDef()
    api.register(routes)
    app = web.Application()
    app.add_routes(routes)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post(
                "/openbio-comfy-mcp/session",
                json={
                    "page_id": "page-a",
                    "client_id": "client-a",
                    "canvas_id": "canvas-a",
                    "workflow_id": "workflow-a",
                    "focused": True,
                    "href": "http://127.0.0.1:8188/#a",
                },
            )
            assert response.status == 200
            assert await response.json() == {"ok": True}

            command_response = asyncio.create_task(
                client.post(
                    "/openbio-comfy-mcp/command",
                    json={
                        "canvas_id": "canvas-a",
                        "command": "inspect_canvas",
                        "arguments": {},
                    },
                )
            )
            while not sent:
                await asyncio.sleep(0)
            payload, _ = sent[0]
            response = await client.post(
                "/openbio-comfy-mcp/reply",
                json={
                    "page_id": "page-a",
                    "request_id": payload["request_id"],
                    "ok": True,
                    "result": {"revision": "1"},
                },
            )
            assert response.status == 200
            assert await response.json() == {"ok": True}

            response = await command_response
            assert response.status == 200
            assert await response.json() == {
                "ok": True,
                "result": {"revision": "1"},
            }

    asyncio.run(exercise())


def test_command_route_rejects_non_loopback_callers():
    relay = Relay(send_event=lambda event, data, sid: None)
    api = RelayAPI(relay)

    class RemoteRequest:
        remote = "192.0.2.10"

    response = asyncio.run(api.command(RemoteRequest()))
    assert response.status == 403
    assert json.loads(response.text) == {
        "ok": False,
        "error": {
            "code": "FORBIDDEN",
            "message": "Canvas commands are accepted from loopback only.",
        },
    }
