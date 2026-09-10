"""ComfyUI V3 extension entry point."""

from comfy_api.latest import ComfyExtension
from server import PromptServer, args

from .registry import InstanceRegistration
from .relay import Relay
from .routes import RelayAPI


class OpenBioComfyMcpExtension(ComfyExtension):
    """Register the bridge transport without adding execution nodes."""

    def __init__(self) -> None:
        self._relay: Relay | None = None
        self._api: RelayAPI | None = None
        self._registration: InstanceRegistration | None = None

    async def on_load(self) -> None:
        prompt_server = PromptServer.instance
        self._relay = Relay(
            send_event=prompt_server.send,
            is_client_connected=lambda client_id: client_id in prompt_server.sockets,
        )
        self._registration = InstanceRegistration(
            prompt_server,
            tls=bool(args.tls_keyfile and args.tls_certfile),
        )
        self._api = RelayAPI(
            self._relay,
            instance_id=self._registration.instance_id,
            prompt_queue=getattr(prompt_server, "prompt_queue", None),
        )
        self._api.register(prompt_server.routes)
        prompt_server.app.cleanup_ctx.append(self._registration.cleanup_ctx)

    async def get_node_list(self) -> list[type]:
        return []
