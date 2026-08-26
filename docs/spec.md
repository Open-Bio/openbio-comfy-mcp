# OpenBio Comfy MCP specification

## Goal

Expose the ComfyUI workflow currently open in a user's browser or Desktop window to a local MCP client. The client can inspect the live canvas, discover installed node types, and apply native node and link changes that appear immediately and can be undone once with ComfyUI's normal undo command.

## Boundaries

- The project is a sibling repository installed through a Junction under `ComfyUI/custom_nodes`.
- It must not modify ComfyUI Core, the OpenBio frontend repository, Desktop, workflow files, or execution-node packages.
- The ComfyUI extension registers no execution nodes.
- The page extension is the only component that reads or mutates the live LiteGraph graph.
- The MCP host is a separate stdio process and does not keep an authoritative workflow copy.
- No tool queues, executes, or saves a workflow automatically.
- No arbitrary JavaScript, DOM automation, shell, or second canvas is exposed.

## Public MCP interface

### `inspect_canvas`

Returns the active live canvas identity, revision, serialized nodes and links, selection, and viewport. A requested page or workflow must match the page that actually executes the command.

### `search_nodes`

Searches ComfyUI's installed `/object_info` catalog by class type, display name, category, description, and input/output names. It returns the minimum schema needed to choose and connect a node.

### `apply_canvas_patch`

Accepts a canvas identity, the revision returned by `inspect_canvas`, and an ordered batch of typed operations:

- `add_node`
- `remove_node`
- `set_input`
- `connect`
- `disconnect`
- `move_node`

New nodes can be referenced later in the same patch by `temp_ref`. The page applies the whole patch as one native ComfyUI transaction. A stale revision or invalid operation performs no write; an unexpected write failure restores the prior graph. A successful patch returns the new revision and resolved node IDs.

## Session and transport behavior

- A page registers its ComfyUI WebSocket client ID and an ephemeral page ID with the plugin relay.
- With one connected page, MCP calls target it automatically.
- With multiple connected pages, the focused page is selected; unresolved ambiguity is reported instead of guessed.
- The plugin uses ComfyUI's existing HTTP/WebSocket server for relay traffic. The stdio MCP host opens no listening port.
- Canvas-writing relay endpoints accept loopback requests only.
- A disconnected page produces `NO_LIVE_CANVAS`; the system never falls back to editing a workflow file.

## Confirmed test seams

1. MCP protocol: initialize, list tools, and call each public tool through stdio.
2. Relay API: page registration, target selection, command correlation, result delivery, timeout, and disconnect behavior.
3. Live canvas: inspect and apply through the public command handler, including one native transaction, unchanged existing-node colors, added-node native rendering, stale rejection, and rollback.
4. Installation: Junction discovery, Codex MCP configuration, real browser connection, visible native graph mutation, and one-step native undo.

