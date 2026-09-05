# OpenBio Comfy MCP specification

## Goal

Expose the ComfyUI workflow currently open in a user's browser or Desktop window to a local MCP client. One MCP connection discovers multiple local ComfyUI instances and binds each selected canvas to its backend. The client can inspect the live canvas, discover installed node types, navigate native subgraphs, and apply native node, link, group, and subgraph changes that appear immediately and can be undone once with ComfyUI's normal undo command.

## Boundaries

- The project is a sibling repository installed through a Junction under `ComfyUI/custom_nodes`.
- It must not modify ComfyUI Core, the OpenBio frontend repository, Desktop, workflow files, or execution-node packages.
- The ComfyUI extension registers no execution nodes.
- The page extension is the only component that reads or mutates the live LiteGraph graph.
- The MCP host is a separate stdio process and does not keep an authoritative workflow copy.
- Instance discovery and transport are local only; remote servers and port scanning are outside scope.
- No tool queues, executes, or saves a workflow automatically.
- No arbitrary JavaScript, DOM automation, shell, or second canvas is exposed.

## Public MCP interface

### `list_instances`

Returns local instances with `instance_id`, `base_url`, `status` (`"online"` or `"unavailable"`), `last_focused_at`, and connected `canvases`. Each canvas exposes its page's `last_focused_at` as Unix epoch milliseconds, or `null` if it has not received focus; older extensions may omit the field. The instance value is the latest available focus time among its connected canvases, or `null` when none is available. A listed canvas can be passed directly to `inspect_canvas` by its `canvas_id`. Listing is read-only and does not select a global target.

### `inspect_canvas`

Accepts an optional `instance_id` or an existing `canvas_id` to select the backend. Explicit identities take priority over focus. With neither, one online instance is selected automatically; with multiple online instances, the instance with the unique latest `last_focused_at` is selected, even when all pages currently report `focused: false`. Missing focus times on all instances or a tie for the latest time across instances returns `AMBIGUOUS_INSTANCE`. A client can resolve a user-specified port to an `instance_id` through `list_instances`. The response includes `instance_id` and an opaque `canvas_id` bound to that running backend. Clients pass the canvas identity back unchanged, preserving the target across subsequent focus changes.

Without `refs`, returns the active live canvas identity, revision, selection, viewport, and a compact topology and geometry projection of its nodes, links, and groups. Node and group IDs are canonical strings scoped to the active graph; the bridge creates no second ref namespace. The response includes the active `graph_id` and the workflow's `root_graph_id`. Subgraph nodes include `subgraph_id`, the native ID of their shared definition.

With native node or group `refs`, returns edit-relevant details only for those items plus links incident to requested nodes. Node details contain named widget values, named input/output slots, and containing group refs. Group details contain native color and flags plus geometrically contained node refs. A requested page or workflow must match the page that actually executes the command.

When the active graph is a subgraph, both inspection forms also include:

```text
subgraph: {
  name,
  inputs: { node_id, slots: [{ name, type, label? }] },
  outputs: { node_id, slots: [{ name, type, label? }] }
}
```

These are native boundary nodes and slots. The input boundary supplies outputs to internal nodes; the output boundary receives inputs from internal nodes. Use their inspected IDs and stable slot names with `connect` and `disconnect`, without hardcoding boundary IDs. Boundary nodes are not ordinary editable workflow nodes.

The revision covers the workflow root and its subgraph definitions, so changes to internal nodes or exposed ports invalidate earlier inspections even when a different graph is visible. Selection and viewport changes do not invalidate the revision.

### `present_canvas`

Accepts the current canvas identity, native node or Group refs, `selection: "replace" | "add"`, `fit_view`, and an optional `graph_id`. The canvas identity selects the backend. Without `graph_id`, presentation targets the active graph. With `graph_id`, it navigates to that native graph in the current workflow; use a node's `subgraph_id` to enter its definition or `root_graph_id` to return to the root. Refs belong to the destination graph and are resolved before navigation or selection changes. It returns the resulting canvas identity, selection, and viewport without requiring a revision, opening a workflow transaction, creating an undo entry, or marking the workflow as modified. After navigation, the returned `canvas_id` remains bound to the same instance; use it to inspect again and obtain the destination revision and refs.

### `search_nodes`

Searches ComfyUI's installed `/object_info` catalog by class type, display name, category, description, and input/output names. It returns the minimum schema needed to choose and connect a node. Accepts `instance_id` or `canvas_id` to query the intended backend; without either, it uses the same default instance selection as `inspect_canvas`.

### `inspect_node_type`

Accepts an exact installed `class_type`, queries ComfyUI's native `/object_info/{node_class}` endpoint, and returns that node type's complete schema without reading or modifying a live canvas. Accepts `instance_id` or `canvas_id` with the same backend selection as `search_nodes`. Unknown class types return `NODE_TYPE_NOT_FOUND`.

Native graph IDs identify workflow definitions, not installed `class_type` values. Inspect and edit subgraphs through the live canvas tools rather than the node catalog.

### `apply_canvas_patch`

Accepts a canvas identity bound to its backend, the revision returned by `inspect_canvas`, and a non-empty ordered batch of typed operations:

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
- `convert_to_subgraph`
- `unpack_subgraph`
- `add_subgraph_port`
- `rename_subgraph_port`
- `remove_subgraph_port`

New nodes and groups can be referenced later in the same patch by `temp_ref`. Group operations use ComfyUI's native `LGraphGroup`; `update_group.bounding` changes only the group rectangle, `fit_group_to_nodes` resizes it around explicit nodes without moving them, and `move_group` follows native Group-drag behavior to move the Group and its contents. Group membership remains ComfyUI's derived geometric state rather than a persisted node-ID list. The page validates the patch container, non-empty operation list, and each operation discriminator before opening a native transaction. It applies the whole patch as one native ComfyUI transaction. A stale revision or invalid operation performs no write; an unexpected write failure restores the prior graph. A successful patch returns the new revision and resolved or changed node and Group IDs.

Subgraph operations reuse native ComfyUI conversion and definition methods:

| Operation | Required fields beyond `op` | Optional fields | Behavior |
| --- | --- | --- | --- |
| `convert_to_subgraph` | Non-empty `node_ids`, `temp_ref` | `title` | Wrap the specified nodes in a subgraph and return its instance ID through `id_map[temp_ref]`. |
| `unpack_subgraph` | `node_id` | — | Expand a subgraph instance into nodes in the active graph. |
| `add_subgraph_port` | `direction`, `name`, `type` | — | Add an exposed port to the active subgraph definition. |
| `rename_subgraph_port` | `direction`, `name`, `label` | — | Change the port's display label, preserving its stable connection name. |
| `remove_subgraph_port` | `direction`, `name` | — | Remove the port and its native connections. |

Port `direction` is `"input"` or `"output"`; `name` and `type` are non-empty strings. Port operations require an active subgraph and can share a patch with ordinary node and link operations. To expose an internal node's output, add an output port, then connect the internal output to the inspected output boundary's `node_id` using the new port name as `input_name`. To route an exposed input inward, connect the input boundary's `node_id` and port name as `output_name` to an internal input. Edits affect the shared subgraph definition and every instance that uses it, including instances elsewhere in the workflow.

`convert_to_subgraph` and `unpack_subgraph` must be the final operation of their patch. Earlier operations may prepare nodes and links, including nodes referenced through `temp_ref`. Native conversion remaps node IDs, so inspect again before using internal or unpacked node refs. Each successful patch remains one native undo transaction, including edits within nested subgraphs; undo and rollback cover the workflow root and its definitions.

## Session and transport behavior

- Each ComfyUI backend registers its loopback base URL and a fresh `instance_id` for that server lifetime under `~/.openbio-comfy-mcp/instances`. The directory can be overridden with `OPENBIO_COMFY_REGISTRY_DIR`; ComfyUI and the MCP host must use the same directory, which they share by default under the same operating-system user.
- Registration is refreshed every 5 seconds, removed on normal shutdown, and ignored after 30 seconds without an update. The MCP host checks health and verifies the registered identity before using an instance, including when a port has been reused by another process.
- With `OPENBIO_COMFY_URL` unset, the host discovers registered instances. With no current registration records, it tries `http://127.0.0.1:8188` for compatibility with older extensions. Setting `OPENBIO_COMFY_URL` explicitly restricts the connection to that local server and disables discovery.
- Public `canvas_id` values bind the native canvas to a specific running backend and remain usable after reconnecting the MCP host with the same discovery configuration. Routing restores the native canvas identity before delivery to the page; native node/group refs and revision behavior remain unchanged. This binding applies to automatic discovery and, with the current extension, explicit URLs and the legacy default address. Older extensions without instance identity retain their previous canvas identity behavior.
- An unavailable or restarted target returns `INSTANCE_UNAVAILABLE` or `INSTANCE_NOT_FOUND` and never causes automatic switching to another instance. Even if the browser page survives a backend restart, an old canvas identity cannot target the new process; list and inspect the new instance to continue. Conflicting instance and canvas identities return `INSTANCE_MISMATCH`.
- A page registers its ComfyUI WebSocket client ID and an ephemeral page ID with the plugin relay.
- The page reports `last_focused_at` when it gains focus, including initialization while focused. Blur and heartbeats preserve that timestamp. Focus times are relayed in memory and are not written to instance registration files or an activity history.
- Within the selected instance, one connected page is targeted automatically.
- With multiple connected pages in the selected instance, the most recently focused page remains the default after focus leaves ComfyUI; if no page has established a default, unresolved ambiguity is reported instead of guessed. Focus chooses a backend only when no explicit instance or canvas identity is supplied; existing canvas bindings remain unchanged.
- The plugin uses ComfyUI's existing HTTP/WebSocket server for relay traffic. The stdio MCP host opens no listening port.
- Canvas-writing relay endpoints accept loopback requests only.
- Malformed session, command, and reply envelopes return `INVALID_REQUEST` before changing relay state.
- A disconnected page produces `NO_LIVE_CANVAS`; the system never falls back to editing a workflow file.

## Confirmed test seams

1. MCP protocol: initialize, list tools, and call each public tool through stdio, including discovery, instance ambiguity, canvas-bound routing, and target availability.
2. Relay API: instance registration and cleanup, page registration, target selection, command correlation, result delivery, timeout, and disconnect behavior.
3. Live canvas: inspect, present, and apply through the public command handler, including native Group selection and editing, one native transaction, unchanged existing-node colors, added-node native rendering, stale rejection, and rollback.
4. Installation: Junction discovery, Codex MCP configuration, real browser connection, visible native graph mutation, and one-step native undo.
