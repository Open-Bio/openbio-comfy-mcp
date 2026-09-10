# OpenBio Comfy MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/openbio-comfy-mcp.svg)](https://www.npmjs.com/package/openbio-comfy-mcp)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![ComfyUI 0.33.0+](https://img.shields.io/badge/ComfyUI-0.33.0%2B-blue.svg)](https://github.com/Comfy-Org/ComfyUI)

Let Cursor, Codex, Claude, or another local AI **inspect, edit, and queue** the workflow currently open on your ComfyUI canvas.

It uses ComfyUI's own graph, selection, groups, undo, and Queue button. It never saves a workflow for you.

This is **not** [Comfy's official MCP](https://docs.comfy.org/agent-tools/mcp). Official Comfy MCP generates images on Comfy Cloud or runs workflow files through `comfy-mcp`. This project edits and queues the live graph you already have open.

## What you can ask

Once both pieces below are installed and a ComfyUI window is open:

- What is on this canvas?
- Add a node, connect these two, or move this group.
- Search the node types installed in *this* ComfyUI.
- Pack or unpack a native subgraph.
- Queue the open canvas and get output file paths when it finishes.

Changes appear on the canvas immediately. One ComfyUI undo reverts a whole patch. Queue uses the same path as the Queue button.

## Install

You need **both** steps. Manager only adds the ComfyUI side. The AI client still needs the MCP server.

### 1. ComfyUI extension

In ComfyUI Manager, search for `OpenBio Comfy MCP` or `openbio-comfy-mcp`, install it, and restart ComfyUI. Keep a browser or Desktop window open while you use the tools.

The extension has no extra Python packages. Registry builds already include the bundled MCP server.

Confirm the relay is up:

```powershell
Invoke-RestMethod http://127.0.0.1:8188/openbio-comfy-mcp/health
```

You should see `"ok": true`. Use your ComfyUI port if it is not `8188`.

### 2. MCP host

Node.js 20+ must be on your `PATH`. Point the host at the published package — do not copy a file path:

```json
{
  "mcpServers": {
    "openbio-comfy-mcp": {
      "command": "npx",
      "args": ["-y", "openbio-comfy-mcp@latest"]
    }
  }
}
```

#### Codex

```powershell
codex mcp add openbio-comfy-mcp -- npx -y openbio-comfy-mcp@latest
codex mcp get openbio-comfy-mcp --json
```

Restart the Codex client after adding it. Desktop, CLI, and the IDE extension share the same host config. See the [Codex MCP docs](https://developers.openai.com/codex/mcp).

#### Cursor

Add the JSON above to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project, then reload MCP.

#### Other stdio hosts (Claude Desktop, Claude Code, …)

Use the same `npx -y openbio-comfy-mcp@latest` command. Key names vary by host; the command must stay `npx`.

Local ComfyUI instances are discovered automatically. You only need one MCP registration even if several ComfyUI processes are running.

## Requirements

- ComfyUI 0.33.0 or newer
- Python 3.10 or newer in the ComfyUI runtime
- Node.js 20 or newer on the PATH of the MCP host
- An MCP host that can launch a local stdio server
- A ComfyUI page left open while the tools run

## Configuration

| Variable | Default | When to set it |
| --- | --- | --- |
| `OPENBIO_COMFY_URL` | Unset (discover locally) | Pin this MCP connection to one instance, for example `http://127.0.0.1:8189` or `http://192.168.1.13:8188`. |
| `OPENBIO_COMFY_REGISTRY_DIR` | `~/.openbio-comfy-mcp/instances` | Override the shared registration directory. ComfyUI and the MCP host must use the same path. |

Install the extension in every ComfyUI instance you want to edit. Each running backend writes its address under the shared directory. Discovery accepts loopback and private LAN addresses (`192.168.x.x`, `10.x`, `172.16–31.x`). Public internet hosts are not supported. ComfyUI listening on `0.0.0.0` still registers as `127.0.0.1`; from another machine set `OPENBIO_COMFY_URL` to that host's LAN URL, for example `http://192.168.1.13:8188`.

With several online instances, tools pick the one whose page was focused last. Say “edit the workflow on port 8189” if you need a specific one. `list_instances` shows `instance_id`, status, and connected canvases.

## Tools

| Tool | Effect | Purpose |
| --- | --- | --- |
| `list_instances` | Read-only | List local instances and connected canvases. |
| `inspect_canvas` | Read-only | Inspect the live graph, subgraphs, or specific nodes and groups. |
| `search_nodes` | Read-only | Search the node types installed in that ComfyUI. |
| `inspect_node_type` | Read-only | Read the native schema of one `class_type`. |
| `present_canvas` | UI only | Navigate graphs, select items, optionally fit the view. |
| `apply_canvas_patch` | Writes the canvas | Apply one atomic, undoable batch of graph edits. |
| `queue_canvas` | Queues the live canvas | Same as the Queue button, including seed widgets. Returns `prompt_id` and `prompt_ids`; does not wait or save. |
| `inspect_prompt` | Read-only | Status of a queued prompt, plus output filenames, local paths, and view URLs. Failed runs are `error`, not `completed`. |
| `wait_for_prompt` | Read-only | Poll until that prompt finishes, fails, or the timeout elapses. |

Typical flow: inspect → search a node type if needed → apply one patch → `queue_canvas` → `wait_for_prompt` → undo in ComfyUI if the graph edit was wrong.

Exact operations live in [docs/spec.md](docs/spec.md).

## Security

- The MCP process runs with the same OS permissions as the host that launched it.
- `apply_canvas_patch` can change the open workflow. `queue_canvas` runs that workflow on your GPU. Review both in your host if you gate write tools.
- The server opens no listening port. Canvas commands are accepted from loopback and private LAN addresses only. That is not a general ComfyUI login; do not expose an unauthenticated ComfyUI to the public internet.
- Inspections can include prompts, filenames, and widget values. What happens next follows your MCP host and model provider.

## Troubleshooting

- `NO_LIVE_CANVAS`: open or reload a ComfyUI page and leave it connected.
- Host shows no tools: confirm Node 20+ is on `PATH`, that the host command is `npx -y openbio-comfy-mcp@latest`, then restart the host.
- Health route missing: the extension is not loaded. Reinstall under `custom_nodes`, restart ComfyUI, check its console.
- `STALE_CANVAS`: inspect again and send a new patch.
- `PROMPT_TIMEOUT`: the queued prompt was still running when `wait_for_prompt` stopped. Call `inspect_prompt` or wait again.
- `AMBIGUOUS_INSTANCE`: several instances, no clear focus. Use `list_instances` and pass an `instance_id` or `canvas_id`.
- `INSTANCE_UNAVAILABLE` / `INSTANCE_NOT_FOUND`: that ComfyUI is down or was restarted. List and inspect again.
- Port `5173` Vite frontend: custom-node JavaScript does not load there. Use the frontend served by ComfyUI.

## Update and uninstall

Manager users: update the extension in ComfyUI Manager, then restart ComfyUI and reload the page. The MCP host always fetches `@latest` on the next `npx` launch.

Remove the host registration first (Codex: `codex mcp remove openbio-comfy-mcp`), then uninstall the custom node and restart ComfyUI.

## Source install

Use this when you are developing the extension, or Manager is not available.

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
Set-Location "$ComfyRoot\custom_nodes"
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
Set-Location .\openbio-comfy-mcp
npm ci
```

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
cd openbio-comfy-mcp
npm ci
```

To keep the Git checkout outside ComfyUI, Junction or symlink it into `custom_nodes`, then run `npm ci` in the checkout. Do not expose the same checkout through more than one custom-node root.

For local MCP testing against that checkout, you can still launch `node dist/openbio-comfy-mcp.mjs` instead of `npx`.

```bash
npm ci
npm test
```

Python relay tests, using the same interpreter as ComfyUI:

```powershell
C:\path\to\ComfyUI\.venv\Scripts\python.exe `
  -m pytest --rootdir=tests -c pyproject.toml tests -q
```

The standalone ComfyUI_frontend Vite server (`pnpm dev`, usually port `5173`) does not load custom-node JavaScript. Open the UI that ComfyUI itself serves.

## License

OpenBio Comfy MCP is released under the [MIT License](LICENSE).

This project uses the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and ComfyUI's documented [V3](https://docs.comfy.org/custom-nodes/v3_migration) and [JavaScript extension](https://docs.comfy.org/custom-nodes/js/javascript_overview) APIs.
