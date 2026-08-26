"""ComfyUI discovery entry point for OpenBio Comfy MCP."""

if __package__:
    from .openbio_comfy_mcp.extension import OpenBioComfyMcpExtension
else:
    from openbio_comfy_mcp.extension import OpenBioComfyMcpExtension


WEB_DIRECTORY = "./web"


async def comfy_entrypoint() -> OpenBioComfyMcpExtension:
    return OpenBioComfyMcpExtension()


__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
