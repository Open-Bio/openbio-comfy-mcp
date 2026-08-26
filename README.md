# OpenBio Comfy MCP

OpenBio Comfy MCP lets a local MCP client inspect and edit the ComfyUI canvas that is currently open in a browser or ComfyUI Desktop. Changes use ComfyUI's native graph, links, dirty tracking, and undo transaction; the bridge never queues, executes, or saves a workflow automatically.

## Architecture

```text
Codex / another MCP client
        | stdio
        v
Node MCP host
        | ComfyUI HTTP
        v
V3 custom extension relay
        | ComfyUI custom WebSocket event
        v
Page extension -> app.canvas.graph
```

The page is the only authority for the live graph. The Python extension only correlates requests with a connected page, and the stdio host keeps no workflow copy. No ComfyUI Core, frontend, Desktop, or workflow-format patch is required.

## Requirements

- ComfyUI 0.33.0 or newer
- Node.js 20 or newer for the independent MCP host
- A local ComfyUI page must be open before canvas tools can be used

The ComfyUI extension has no additional Python dependencies and registers no execution nodes.

## Install beside ComfyUI

Install the MCP host dependency in this repository:

```powershell
Set-Location D:\learn\openbio-comfy-mcp
npm ci
```

Expose the repository to ComfyUI with a Junction:

```powershell
New-Item -ItemType Junction `
  -Path D:\learn\ComfyUI\custom_nodes\openbio-comfy-mcp `
  -Target D:\learn\openbio-comfy-mcp
```

Restart ComfyUI after adding or removing the Junction. A normal OpenBio launch is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File D:\learn\openbio-singlecell\scripts\start.ps1 `
  -ComfyRoot D:\learn\ComfyUI `
  -FrontendRoot D:\learn\ComfyUI_frontend `
  -Python D:\learn\ComfyUI\.venv\Scripts\python.exe `
  --listen 127.0.0.1 `
  --port 8188
```

## Connect Codex

Register the stdio host with absolute paths:

```powershell
codex mcp add openbio-comfy-mcp `
  --env OPENBIO_COMFY_URL=http://127.0.0.1:8188 `
  -- "C:\Program Files\nodejs\node.exe" `
  D:\learn\openbio-comfy-mcp\mcp_host\cli.mjs
```

Verify the saved configuration:

```powershell
codex mcp get openbio-comfy-mcp --json
codex mcp list --json
```

Restart the Codex client after adding the server. Codex Desktop, CLI, and the IDE extension share the same host configuration, as described in the [official MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Tools

- `inspect_canvas`: reads the exact connected canvas, revision, native nodes and links, selection, and viewport.
- `search_nodes`: searches the installed ComfyUI `/object_info` catalog and returns a compact connection schema.
- `apply_canvas_patch`: applies one ordered `add_node`, `remove_node`, `set_input`, `connect`, `disconnect`, or `move_node` batch as one native undo transaction.

The expected editing flow is:

1. Inspect the live canvas.
2. Search for any node types needed by the change.
3. Apply one patch with the returned `canvas_id` and `revision` as `base_revision`.
4. Inspect again, or use ComfyUI's native undo if the change is not wanted.

Only one lightweight revision comparison is made immediately before writing. A stale patch does not write and must be rebuilt from a fresh inspection.
Before the native transaction starts, the bridge resolves node types, references, widgets, slots, protected removals, and connection types without invoking widget callbacks or changing the live graph.

## Security and privacy

- Canvas command requests are accepted from loopback only.
- The bridge exposes typed graph operations, never arbitrary JavaScript, DOM access, filesystem access, shell commands, queueing, or execution.
- A closed or disconnected page returns `NO_LIVE_CANVAS`; there is no fallback that edits workflow files in the background.
- Canvas snapshots can contain node values, filenames, prompts, and workflow structure. They are provided to the configured MCP client when it calls `inspect_canvas`; any onward model or service handling follows that client's privacy policy.
- If ComfyUI is exposed beyond `127.0.0.1`, do not assume the rest of ComfyUI has authentication merely because this bridge restricts its write endpoint.

## Tests

```powershell
Set-Location D:\learn\openbio-comfy-mcp
npm test

D:\learn\ComfyUI\.venv\Scripts\python.exe `
  -m pytest --rootdir=tests -c pyproject.toml tests -q
```

The Node tests include a real stdio MCP initialization, tool listing, and tool call against a local fake ComfyUI server. Python tests cover the V3 entry point and live-page relay behavior.

## Uninstall

Remove the Codex registration:

```powershell
codex mcp remove openbio-comfy-mcp
```

Then remove only the Junction at `D:\learn\ComfyUI\custom_nodes\openbio-comfy-mcp` and restart ComfyUI. The sibling repository and both upstream repositories remain unchanged.
