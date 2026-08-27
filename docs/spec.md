# OpenBio Comfy MCP specification

## Goal

Expose the ComfyUI workflow currently open in a user's browser or Desktop window to a local MCP client. The client can inspect the live canvas, discover installed node types, and apply native node, link, and group changes that appear immediately and can be undone once with ComfyUI's normal undo command.

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

Without `refs`, returns the active live canvas identity, revision, selection, viewport, and a compact topology and geometry projection of its nodes, links, and groups. Node and group IDs are canonical strings and serve directly as stable refs within that workflow; the bridge creates no second ref namespace.

With native node or group `refs`, returns edit-relevant details only for those items plus links incident to requested nodes. Node details contain named widget values, named input/output slots, and containing group refs. Group details contain native color and flags plus geometrically contained node refs. A requested page or workflow must match the page that actually executes the command.

### `present_canvas`

Accepts a canvas identity, native node or Group refs, `selection: "replace" | "add"`, and `fit_view`. Every ref is resolved before the current selection changes. It returns the resulting selection and viewport without requiring a revision, opening a workflow transaction, creating an undo entry, or marking the workflow as modified.

### `search_nodes`

Searches ComfyUI's installed `/object_info` catalog by class type, display name, category, description, and input/output names. It returns the minimum schema needed to choose and connect a node.

### `inspect_node_type`

Accepts an exact installed `class_type`, queries ComfyUI's native `/object_info/{node_class}` endpoint, and returns that node type's complete schema without reading or modifying a live canvas. Unknown class types return `NODE_TYPE_NOT_FOUND`.

### `apply_canvas_patch`

Accepts a canvas identity, the revision returned by `inspect_canvas`, and a non-empty ordered batch of typed operations:

- `add_node`
- `remove_node`
- `set_input`
- `connect`
- `disconnect`
- `move_node`
- `add_group`
- `update_group`
- `move_group`
- `fit_group_to_nodes`
- `remove_group`

New nodes and groups can be referenced later in the same patch by `temp_ref`. Group operations use ComfyUI's native `LGraphGroup`; `update_group.bounding` changes only the group rectangle, `fit_group_to_nodes` resizes it around explicit nodes without moving them, and `move_group` follows native Group-drag behavior to move the Group and its contents. Group membership remains ComfyUI's derived geometric state rather than a persisted node-ID list. The page validates the patch container, non-empty operation list, and each operation discriminator before opening a native transaction. It applies the whole patch as one native ComfyUI transaction. A stale revision or invalid operation performs no write; an unexpected write failure restores the prior graph. A successful patch returns the new revision and resolved or changed node and Group IDs.

## Session and transport behavior

- A page registers its ComfyUI WebSocket client ID and an ephemeral page ID with the plugin relay.
- With one connected page, MCP calls target it automatically.
- With multiple connected pages, the most recently focused page remains the default after focus leaves ComfyUI; if no page has established a default, unresolved ambiguity is reported instead of guessed.
- The plugin uses ComfyUI's existing HTTP/WebSocket server for relay traffic. The stdio MCP host opens no listening port.
- Canvas-writing relay endpoints accept loopback requests only.
- Malformed session, command, and reply envelopes return `INVALID_REQUEST` before changing relay state.
- A disconnected page produces `NO_LIVE_CANVAS`; the system never falls back to editing a workflow file.

## Confirmed test seams

1. MCP protocol: initialize, list tools, and call each public tool through stdio.
2. Relay API: page registration, target selection, command correlation, result delivery, timeout, and disconnect behavior.
3. Live canvas: inspect, present, and apply through the public command handler, including native Group selection and editing, one native transaction, unchanged existing-node colors, added-node native rendering, stale rejection, and rollback.
4. Installation: Junction discovery, Codex MCP configuration, real browser connection, visible native graph mutation, and one-step native undo.
