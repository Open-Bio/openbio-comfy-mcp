import asyncio
import json
import os
import types

from openbio_comfy_mcp import registry


def test_local_base_url_advertises_loopback_and_private_lan_and_preserves_tls():
    assert registry.local_base_url("127.0.0.1", 8189) == "http://127.0.0.1:8189"
    assert registry.local_base_url("0.0.0.0", 8190) == "http://127.0.0.1:8190"
    assert registry.local_base_url("::", 8191) == "http://[::1]:8191"
    assert registry.local_base_url("::1", 8192, tls=True) == "https://[::1]:8192"
    assert registry.local_base_url("192.168.1.13", 8188) == "http://192.168.1.13:8188"
    assert registry.local_base_url("8.8.8.8", 8188) is None


def test_registry_waits_for_listener_refreshes_and_cleans_only_its_own_record(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("OPENBIO_COMFY_REGISTRY_DIR", str(tmp_path))
    monkeypatch.setattr(registry, "HEARTBEAT_INTERVAL", 0.001)
    server = types.SimpleNamespace()
    registration = registry.InstanceRegistration(server, tls=True)
    own_file = tmp_path / f"{registration.instance_id}.json"
    other_file = tmp_path / "other-instance.json"
    other_file.write_text("{}", encoding="utf-8")

    async def exercise():
        context = registration.cleanup_ctx(None)
        await anext(context)
        await asyncio.sleep(0.003)
        assert not own_file.exists()
        server.address, server.port = "0.0.0.0", 8199

        async def read_when_ready():
            while not own_file.exists():
                await asyncio.sleep(0.001)
            return json.loads(own_file.read_text(encoding="utf-8"))

        record = await asyncio.wait_for(read_when_ready(), 1)
        assert record == {
            "instance_id": registration.instance_id,
            "base_url": "https://127.0.0.1:8199",
            "pid": os.getpid(),
            "updated_at": record["updated_at"],
            "name": "ComfyUI :8199",
        }
        await asyncio.sleep(0.01)
        refreshed = json.loads(own_file.read_text(encoding="utf-8"))
        assert refreshed["updated_at"] > record["updated_at"]
        await context.aclose()
        assert not own_file.exists()
        assert other_file.exists()
        assert list(tmp_path.glob("*.tmp")) == []

    asyncio.run(exercise())


def test_registry_write_failure_is_logged_without_failing_server_startup(
    tmp_path, monkeypatch, caplog,
):
    invalid_directory = tmp_path / "file"
    invalid_directory.write_text("occupied", encoding="utf-8")
    monkeypatch.setenv("OPENBIO_COMFY_REGISTRY_DIR", str(invalid_directory))
    registration = registry.InstanceRegistration(
        types.SimpleNamespace(address="127.0.0.1", port=8188),
    )

    async def exercise():
        context = registration.cleanup_ctx(None)
        await anext(context)
        await asyncio.sleep(0)
        await context.aclose()

    asyncio.run(exercise())
    assert "Could not register local ComfyUI instance" in caplog.text
