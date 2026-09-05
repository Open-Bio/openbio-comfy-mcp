import asyncio
import json

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from openbio_comfy_mcp.relay import COMMAND_EVENT, Relay, RelayError
from openbio_comfy_mcp.routes import RelayAPI


def _relay_app(
    relay: Relay, *, command_timeout: float = 10.0, instance_id: str | None = None,
) -> web.Application:
    routes = web.RouteTableDef()
    RelayAPI(relay, command_timeout=command_timeout, instance_id=instance_id).register(routes)
    app = web.Application()
    app.add_routes(routes)
    return app


async def _assert_invalid_request(response, message: str) -> None:
    assert response.status == 400
    assert await response.json() == {
        "ok": False,
        "error": {
            "code": "INVALID_REQUEST",
            "message": message,
        },
    }


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


def test_most_recently_focused_page_remains_default_after_all_pages_blur():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((data, sid)))

    def register(suffix, focused):
        relay.register_session(
            page_id=f"page-{suffix}",
            client_id=f"client-{suffix}",
            canvas_id=f"canvas-{suffix}",
            workflow_id=f"workflow-{suffix}",
            focused=focused,
            href=None,
        )

    register("a", True)
    register("b", False)
    register("a", False)
    register("b", True)
    register("b", False)

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
    app = _relay_app(relay, command_timeout=0.1)

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


def test_session_route_rejects_invalid_envelopes_without_registering_a_canvas():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)
    valid = {
        "page_id": "page-a",
        "client_id": "client-a",
        "canvas_id": "canvas-a",
        "workflow_id": "workflow-a",
        "focused": True,
        "href": "http://127.0.0.1:8188/#a",
    }
    invalid_bodies = [
        [],
        {**valid, "page_id": 7},
        {**valid, "page_id": ""},
        {**valid, "client_id": []},
        {**valid, "canvas_id": None},
        {**valid, "workflow_id": 7},
        {**valid, "focused": "true"},
        *[
            {**valid, "last_focused_at": value}
            for value in (True, "123", -1, float("nan"), float("inf"))
        ],
        {**valid, "href": 7},
    ]

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            for body in invalid_bodies:
                response = await client.post("/openbio-comfy-mcp/session", json=body)
                await _assert_invalid_request(
                    response,
                    "Session registration is missing required fields.",
                )

            response = await client.post(
                "/openbio-comfy-mcp/command",
                json={"command": "inspect_canvas", "arguments": {}},
            )
            assert response.status == 409
            assert (await response.json())["error"]["code"] == "NO_LIVE_CANVAS"

    asyncio.run(exercise())


def test_relay_routes_reject_malformed_json_envelopes():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)
    requests = [
        ("/openbio-comfy-mcp/session", "Session registration is missing required fields."),
        ("/openbio-comfy-mcp/command", "Command is missing required fields."),
        ("/openbio-comfy-mcp/reply", "Reply is missing required fields."),
    ]

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            for route, message in requests:
                response = await client.post(
                    route,
                    data=b"{",
                    headers={"Content-Type": "application/json"},
                )
                await _assert_invalid_request(response, message)

    asyncio.run(exercise())


def test_command_route_rejects_a_json_value_that_is_not_an_object():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post("/openbio-comfy-mcp/command", json=[])

            await _assert_invalid_request(response, "Command is missing required fields.")

    asyncio.run(exercise())


def test_command_route_rejects_json_with_an_unknown_charset():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post(
                "/openbio-comfy-mcp/command",
                data=b"{}",
                headers={"Content-Type": "application/json; charset=not-a-real-charset"},
            )

            await _assert_invalid_request(response, "Command is missing required fields.")

    asyncio.run(exercise())


def test_command_route_rejects_invalid_envelopes_before_selecting_a_canvas():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)
    valid = {"canvas_id": "canvas-a", "command": "inspect_canvas", "arguments": {}}
    invalid_bodies = [
        {**valid, "canvas_id": 7},
        {**valid, "canvas_id": ""},
        {**valid, "instance_id": 7},
        {**valid, "instance_id": ""},
        {**valid, "command": None},
        {**valid, "command": ""},
        {**valid, "arguments": []},
        {**valid, "arguments": None},
    ]

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            for body in invalid_bodies:
                response = await client.post("/openbio-comfy-mcp/command", json=body)
                await _assert_invalid_request(response, "Command is missing required fields.")

    asyncio.run(exercise())


def test_command_route_does_not_misreport_relay_type_errors_as_invalid_requests():
    def fail_to_send(event, data, sid):
        raise TypeError("relay implementation failed")

    relay = Relay(send_event=fail_to_send)
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=True,
        href=None,
    )
    app = _relay_app(relay)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post(
                "/openbio-comfy-mcp/command",
                json={"canvas_id": "canvas-a", "command": "inspect_canvas", "arguments": {}},
            )
            assert response.status == 500

    asyncio.run(exercise())


def test_reply_route_rejects_a_failure_without_an_error_envelope():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append((data, sid)))
    relay.register_session(
        page_id="page-a",
        client_id="client-a",
        canvas_id="canvas-a",
        workflow_id=None,
        focused=True,
        href=None,
    )
    app = _relay_app(relay, command_timeout=0.1)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            command_response = asyncio.create_task(
                client.post(
                    "/openbio-comfy-mcp/command",
                    json={"canvas_id": "canvas-a", "command": "inspect_canvas", "arguments": {}},
                )
            )
            while not sent:
                await asyncio.sleep(0)
            payload, _ = sent[0]

            response = await client.post(
                "/openbio-comfy-mcp/reply",
                json={"page_id": "page-a", "request_id": payload["request_id"], "ok": False},
            )

            await _assert_invalid_request(response, "Reply is missing required fields.")
            response = await client.post(
                "/openbio-comfy-mcp/reply",
                json={
                    "page_id": "page-a",
                    "request_id": payload["request_id"],
                    "ok": False,
                    "error": {
                        "code": "canvas_failed",
                        "message": "Canvas failed",
                        "details": {"operation_index": 0},
                    },
                },
            )
            assert response.status == 200
            assert await response.json() == {"ok": True}

            command_error_response = await command_response
            assert command_error_response.status == 409
            assert await command_error_response.json() == {
                "ok": False,
                "error": {
                    "code": "canvas_failed",
                    "message": "Canvas failed",
                    "details": {"operation_index": 0},
                },
            }

    asyncio.run(exercise())


def test_reply_route_requires_a_boolean_ok_field():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post(
                "/openbio-comfy-mcp/reply",
                json={"page_id": "page-a", "request_id": "request-a", "ok": "false"},
            )

            await _assert_invalid_request(response, "Reply is missing required fields.")

    asyncio.run(exercise())


def test_reply_route_rejects_a_json_value_that_is_not_an_object():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            response = await client.post("/openbio-comfy-mcp/reply", json=[])

            await _assert_invalid_request(response, "Reply is missing required fields.")

    asyncio.run(exercise())


def test_reply_route_rejects_invalid_envelopes_before_matching_a_request():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay)
    valid = {"page_id": "page-a", "request_id": "request-a", "ok": True, "result": {}}
    valid_error = {"code": "canvas_failed", "message": "Canvas failed"}
    invalid_bodies = [
        {**valid, "page_id": 7},
        {**valid, "page_id": ""},
        {**valid, "request_id": None},
        {**valid, "request_id": ""},
        {**valid, "ok": False, "error": []},
        {**valid, "ok": False, "error": {}},
        {**valid, "ok": False, "error": {**valid_error, "code": 7}},
        {**valid, "ok": False, "error": {**valid_error, "code": ""}},
        {**valid, "ok": False, "error": {**valid_error, "message": None}},
        {**valid, "ok": False, "error": {**valid_error, "message": ""}},
        {**valid, "ok": False, "error": {**valid_error, "details": []}},
    ]

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            for body in invalid_bodies:
                response = await client.post("/openbio-comfy-mcp/reply", json=body)
                await _assert_invalid_request(response, "Reply is missing required fields.")

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


def test_health_exposes_only_live_canvases_to_loopback_callers():
    now = [0.0]
    connected = {"client-live", "client-expired"}
    relay = Relay(
        send_event=lambda event, data, sid: None,
        clock=lambda: now[0],
        is_client_connected=lambda client_id: client_id in connected,
    )
    for suffix in ("expired", "closed", "live"):
        if suffix != "expired":
            now[0] = 16.0
        relay.register_session(
            page_id=f"page-{suffix}",
            client_id=f"client-{suffix}",
            canvas_id=f"canvas-{suffix}",
            workflow_id="workflow-a",
            focused=True,
            href="http://127.0.0.1:8189/#a",
        )
    api = RelayAPI(relay, instance_id="instance-a")

    class Request:
        remote = "127.0.0.1"

    response = asyncio.run(api.health(Request()))
    assert json.loads(response.text) == {
        "ok": True,
        "instance_id": "instance-a",
        "canvases": [{
            "canvas_id": "canvas-live",
            "page_id": "page-live",
            "workflow_id": "workflow-a",
            "focused": True,
            "last_focused_at": None,
            "href": "http://127.0.0.1:8189/#a",
        }],
    }
    Request.remote = "192.0.2.10"
    response = asyncio.run(api.health(Request()))
    assert json.loads(response.text) == {"ok": True}


def test_session_route_preserves_reported_focus_time_in_health_after_blur_and_heartbeat():
    relay = Relay(send_event=lambda event, data, sid: None)
    app = _relay_app(relay, instance_id="instance-a")
    registration = {
        "page_id": "page-a",
        "client_id": "client-a",
        "canvas_id": "canvas-a",
    }

    async def exercise():
        async with TestClient(TestServer(app)) as client:
            for focused, last_focused_at in (
                (False, None),
                (True, 1_700_000_000_000),
                (False, 1_700_000_000_000),
                (False, 1_700_000_000_000),
                (True, 1_700_000_010_000.5),
            ):
                response = await client.post(
                    "/openbio-comfy-mcp/session",
                    json={
                        **registration,
                        "focused": focused,
                        "last_focused_at": last_focused_at,
                    },
                )
                assert response.status == 200
                response = await client.get("/openbio-comfy-mcp/health")
                canvas = (await response.json())["canvases"][0]
                assert canvas["focused"] is focused
                assert canvas["last_focused_at"] == last_focused_at

            response = await client.post(
                "/openbio-comfy-mcp/session",
                json={
                    **registration,
                    "focused": False,
                    "last_focused_at": 1_700_000_000_000,
                },
            )
            assert response.status == 200
            response = await client.get("/openbio-comfy-mcp/health")
            canvas = (await response.json())["canvases"][0]
            assert canvas["focused"] is False
            assert canvas["last_focused_at"] == 1_700_000_010_000.5

    asyncio.run(exercise())


def test_command_rejects_reused_port_identity_before_dispatch():
    sent = []
    relay = Relay(send_event=lambda event, data, sid: sent.append(data))
    api = RelayAPI(relay, instance_id="instance-new")

    class Request:
        remote = "127.0.0.1"

        async def json(self):
            return {
                "instance_id": "instance-old",
                "canvas_id": "canvas-a",
                "command": "apply_canvas_patch",
                "arguments": {},
            }

    response = asyncio.run(api.command(Request()))
    assert response.status == 409
    assert json.loads(response.text)["error"]["code"] == "INSTANCE_MISMATCH"
    assert sent == []
