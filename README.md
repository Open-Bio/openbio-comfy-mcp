# OpenBio Comfy MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![ComfyUI 0.33.0+](https://img.shields.io/badge/ComfyUI-0.33.0%2B-blue.svg)](https://github.com/Comfy-Org/ComfyUI)

OpenBio Comfy MCP is a local [Model Context Protocol](https://modelcontextprotocol.io/) server and ComfyUI V3 extension for inspecting and editing the workflow currently open on a live ComfyUI canvas. It uses ComfyUI's native graph, selection, group, dirty-state, and undo behavior; it never queues, executes, or saves a workflow automatically.

> [!IMPORTANT]
> Published releases are installable through ComfyUI Manager. Registry packages include a bundled MCP server, so Manager users do not need to run `npm ci`.

## Features

- Inspect the active canvas as compact, structured MCP output.
- Search all node types installed in the connected ComfyUI instance.
- Inspect the complete native schema of an exact node type.
- Select and focus native nodes or groups without modifying the workflow.
- Add, remove, connect, disconnect, configure, and move nodes.
- Add, update, fit, move, and remove native ComfyUI groups.
- Create and unpack native subgraphs, navigate into them, and edit their nodes, links, and exposed ports.
- Apply a batch as one atomic, undoable native ComfyUI transaction.
- Reject stale or invalid patches before changing the live graph.
- Keep the MCP transport local: the stdio server opens no listening port, and canvas commands are accepted by the relay from loopback only.

## Architecture

```text
MCP host application (Codex or another local host)
        | MCP over stdio
        v
Node.js MCP server
        | ComfyUI HTTP
        v
Python V3 extension relay
        | ComfyUI WebSocket event
        v
Browser page extension -> active app.canvas.graph
```

The browser page is the authority for the live graph. The Python extension correlates requests with a connected page, while the Node.js stdio server keeps no authoritative workflow copy. The extension registers no ComfyUI execution nodes and does not patch ComfyUI Core, ComfyUI_frontend, Desktop, or the workflow file format.

## Requirements

- ComfyUI 0.33.0 or newer
- Python 3.10 or newer in the ComfyUI runtime
- Node.js 20 or newer
- An MCP host application that supports local stdio servers
- A ComfyUI browser or Desktop page kept open while the tools are used

The ComfyUI extension has no additional Python package dependencies. Registry releases include a prebuilt MCP server. For source and development checkouts, `npm ci` installs only Node.js dependencies and builds that server; it does not modify the ComfyUI Python environment.

## Install

### ComfyUI Manager (recommended)

Open ComfyUI Manager, search for `OpenBio Comfy MCP` or `openbio-comfy-mcp`, select **Install**, and restart ComfyUI. The installed MCP entry point is:

```text
<ComfyUI>/custom_nodes/openbio-comfy-mcp/dist/openbio-comfy-mcp.mjs
```

No `npm ci` step is required for a Registry installation.

### Standard source installation

Clone the repository directly into ComfyUI's `custom_nodes` directory, then install the MCP server dependency and build the bundled entry point.

Windows PowerShell:

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
Set-Location "$ComfyRoot\custom_nodes"
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
Set-Location .\openbio-comfy-mcp
npm ci
```

Linux or macOS:

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/Open-Bio/openbio-comfy-mcp.git
cd openbio-comfy-mcp
npm ci
```

Restart ComfyUI after installation, open its UI in a browser, and verify that the extension route is available:

```powershell
Invoke-RestMethod http://127.0.0.1:8188/openbio-comfy-mcp/health
```

The expected response is `{ "ok": true }`.

### Sibling checkout for development

Keep the Git checkout outside ComfyUI and expose it through a link when you want edits to remain in a standalone repository.

Windows PowerShell:

```powershell
$ComfyRoot = "C:\path\to\ComfyUI"
$Repo = "C:\path\to\openbio-comfy-mcp"

New-Item -ItemType Junction `
  -Path "$ComfyRoot\custom_nodes\openbio-comfy-mcp" `
  -Target $Repo

Set-Location $Repo
npm ci
```

Linux or macOS:

```bash
ln -s /path/to/openbio-comfy-mcp /path/to/ComfyUI/custom_nodes/openbio-comfy-mcp
cd /path/to/openbio-comfy-mcp
npm ci
```

Do not expose the same checkout through more than one custom-node root.

## Connect an MCP host

### Codex

Register the local stdio server with an absolute path:

```powershell
$Repo = (Resolve-Path "C:\path\to\openbio-comfy-mcp").Path

codex mcp add openbio-comfy-mcp `
  --env OPENBIO_COMFY_URL=http://127.0.0.1:8188 `
  -- node "$Repo\dist\openbio-comfy-mcp.mjs"

codex mcp get openbio-comfy-mcp --json
codex mcp list --json
```

Restart the Codex client after adding the server. Codex Desktop, the CLI, and the IDE extension share MCP configuration on the same Codex host. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Other stdio MCP hosts

For hosts that use an `mcpServers` JSON configuration, adapt this example with an absolute path:

```json
{
  "mcpServers": {
    "openbio-comfy-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\openbio-comfy-mcp\\dist\\openbio-comfy-mcp.mjs"],
      "env": {
        "OPENBIO_COMFY_URL": "http://127.0.0.1:8188"
      }
    }
  }
}
```

Configuration keys vary by host. The command must start `dist/openbio-comfy-mcp.mjs`, and `OPENBIO_COMFY_URL` must point to the local ComfyUI server.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENBIO_COMFY_URL` | `http://127.0.0.1:8188` | Base URL of the ComfyUI server used by the local MCP server. |

## Tools

| Tool | Effect | Purpose |
| --- | --- | --- |
| `inspect_canvas` | Read-only | Inspect compact topology, subgraph navigation and ports, or details for exact native node/group refs. |
| `search_nodes` | Read-only | Search the connected ComfyUI `/object_info` catalog. |
| `inspect_node_type` | Read-only | Read the complete native schema for one exact `class_type`. |
| `present_canvas` | UI state only | Navigate between native graphs, select and optionally fit their items. |
| `apply_canvas_patch` | Writes the live canvas | Apply one atomic, undoable batch of typed node, link, group, or subgraph operations. |

Recommended editing flow:

1. Call `inspect_canvas` and keep the returned `canvas_id` and `revision`.
2. Use `search_nodes` and `inspect_node_type` before adding an unfamiliar node type.
3. Send one `apply_canvas_patch` with the inspected `canvas_id` and `revision` as `base_revision`.
4. Optionally call `present_canvas` to select and focus the changed items.
5. Inspect again. If the result is unwanted, use ComfyUI's native undo command.

For subgraphs, `inspect_canvas` returns `root_graph_id` and a `subgraph_id` on each subgraph node. Pass either native graph ID as `present_canvas.graph_id`, together with the current `canvas_id`; `refs` refer to items in the destination graph. Use the returned canvas identity and inspect again before editing. Native graph IDs are workflow definitions, not installed node types from `/object_info`.

Inside a subgraph, inspection also returns `subgraph.inputs` and `subgraph.outputs`, each with a boundary `node_id` and named `slots`. Use those IDs and slot names with ordinary `connect` and `disconnect` operations. Add, relabel, or remove exposed ports with `add_subgraph_port`, `rename_subgraph_port`, and `remove_subgraph_port`; a relabel changes `label` while preserving the connection `name`. Editing a subgraph definition affects every instance that shares it.

Use `convert_to_subgraph` to wrap explicit `node_ids` and `unpack_subgraph` to expand an instance. Either operation must be last in its patch because native conversion remaps node IDs; inspect again afterward. Each patch, including subgraph edits, remains one native undo transaction.

See [docs/spec.md](docs/spec.md) for the exact public behavior and operation set.

## Frontend development note

The standalone ComfyUI_frontend Vite development server (`pnpm dev`, normally port `5173`) does not load JavaScript extensions supplied by custom nodes. OpenBio Comfy MCP therefore cannot connect to a canvas served only by that development server. Use the frontend served by ComfyUI itself, or build the frontend and launch ComfyUI with that build as its frontend root.

After installing or updating this repository, restart ComfyUI and reload the browser page so the page extension is loaded.

## Security and privacy

- Install MCP servers only from sources you trust. This local server runs with the same operating-system permissions as the MCP host application that launches it.
- Treat `apply_canvas_patch` as a write-capable tool and review or approve its use in your MCP host. It changes the workflow currently open in the selected page, although the whole patch can be reverted with one native undo.
- The stdio MCP server opens no network listener. It calls the configured ComfyUI HTTP server, which defaults to `http://127.0.0.1:8188`.
- Canvas command requests are accepted from loopback only. This restriction is not a general authentication layer for ComfyUI; do not expose an unauthenticated ComfyUI server to untrusted networks.
- The bridge exposes typed graph operations, not arbitrary JavaScript, DOM access, filesystem access, shell commands, workflow queueing, or execution.
- Canvas inspections can include workflow names, paths, node titles, prompts, filenames, sample identifiers, and widget values. Any onward handling follows the privacy policy and configuration of the MCP host and model provider you connect.
- A disconnected page returns `NO_LIVE_CANVAS`; the system never falls back to editing workflow files in the background.

## Troubleshooting

- `NO_LIVE_CANVAS`: open or reload a ComfyUI page and leave it connected.
- Tools are missing in the host: verify the absolute `dist/openbio-comfy-mcp.mjs` path and restart the MCP host application. For a source checkout, run `npm ci` first.
- Health endpoint is missing: verify the repository is directly under `custom_nodes` or linked there, then restart ComfyUI and inspect its console for import errors.
- `STALE_CANVAS`: call `inspect_canvas` again and build a new patch from the returned revision.
- Multiple pages are open: the most recently focused ComfyUI page is the default target; an unresolved ambiguity is reported instead of guessed.
- Port `5173` development page does not connect: use a frontend served by the ComfyUI backend as described above.

## Update and uninstall

Update a source installation and its locked Node.js dependencies:

```bash
git pull --ff-only
npm ci
```

Restart ComfyUI and reload its browser page after an update.

To uninstall, first remove the MCP host registration. For Codex:

```powershell
codex mcp remove openbio-comfy-mcp
```

Then remove the cloned `openbio-comfy-mcp` directory—or only the Junction/symbolic link for a sibling development checkout—from `ComfyUI/custom_nodes`, and restart ComfyUI.

## Development

Install Node.js dependencies and run the MCP/page-extension tests:

```bash
npm ci
npm test
```

Run the Python relay tests with the same interpreter used by ComfyUI:

```powershell
C:\path\to\ComfyUI\.venv\Scripts\python.exe `
  -m pytest --rootdir=tests -c pyproject.toml tests -q
```

Repository layout:

```text
dist/                     Bundled, dependency-free Registry MCP entry point
mcp_host/                 Node.js stdio MCP server
openbio_comfy_mcp/        ComfyUI V3 Python relay extension
scripts/                  Reproducible MCP bundle build
web/                      Live page extension and canvas bridge
tests/                    Node.js and Python tests
docs/spec.md              Public behavior and safety boundaries
```

Issues and pull requests are welcome. Please keep changes inside the project's documented live-canvas and local-transport boundaries, and run both test suites before submitting.

## License

OpenBio Comfy MCP is released under the [MIT License](LICENSE).

This project uses the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and ComfyUI's documented [V3 extension](https://docs.comfy.org/custom-nodes/v3_migration) and [JavaScript extension](https://docs.comfy.org/custom-nodes/js/javascript_overview) mechanisms.
