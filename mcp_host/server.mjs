import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { McpHostError, unavailableError } from "./errors.mjs";
import { createInstanceRouter } from "./instances.mjs";
import { inspectNodeType, searchNodes } from "./search_nodes.mjs";

const NODE_REFERENCE_SCHEMA = { type: ["string", "integer"] };
const INSTANCE_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "Local ComfyUI instance ID returned by list_instances or a previous inspection.",
};
const CANVAS_REFERENCE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["node", "group"] },
    id: NODE_REFERENCE_SCHEMA,
  },
  required: ["kind", "id"],
  additionalProperties: false,
};
const POSITION_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
};
const BOUNDING_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
};
const PATCH_OPERATION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        op: { const: "add_node" },
        temp_ref: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
        },
        class_type: { type: "string", minLength: 1 },
        pos: POSITION_SCHEMA,
      },
      required: ["op", "temp_ref", "class_type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "remove_node" },
        node_id: NODE_REFERENCE_SCHEMA,
      },
      required: ["op", "node_id"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "set_input" },
        node_id: NODE_REFERENCE_SCHEMA,
        input_name: { type: "string", minLength: 1 },
        value: {},
      },
      required: ["op", "node_id", "input_name", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "connect" },
        source: NODE_REFERENCE_SCHEMA,
        output_name: { type: "string", minLength: 1 },
        target: NODE_REFERENCE_SCHEMA,
        input_name: { type: "string", minLength: 1 },
      },
      required: ["op", "source", "output_name", "target", "input_name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "disconnect" },
        target: NODE_REFERENCE_SCHEMA,
        input_name: { type: "string", minLength: 1 },
      },
      required: ["op", "target", "input_name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "move_node" },
        node_id: NODE_REFERENCE_SCHEMA,
        pos: POSITION_SCHEMA,
      },
      required: ["op", "node_id", "pos"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "add_group" },
        temp_ref: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
        },
        title: { type: "string" },
        bounding: BOUNDING_SCHEMA,
        color: { type: "string" },
        pinned: { type: "boolean" },
      },
      required: ["op", "temp_ref", "title"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "update_group" },
        group_id: NODE_REFERENCE_SCHEMA,
        title: { type: "string" },
        bounding: BOUNDING_SCHEMA,
        color: { type: ["string", "null"] },
        pinned: { type: "boolean" },
      },
      required: ["op", "group_id"],
      minProperties: 3,
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "move_group" },
        group_id: NODE_REFERENCE_SCHEMA,
        delta: POSITION_SCHEMA,
      },
      required: ["op", "group_id", "delta"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "remove_group" },
        group_id: NODE_REFERENCE_SCHEMA,
      },
      required: ["op", "group_id"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "fit_group_to_nodes" },
        group_id: NODE_REFERENCE_SCHEMA,
        node_ids: {
          type: "array",
          items: NODE_REFERENCE_SCHEMA,
          minItems: 1,
        },
        padding: { type: "number", minimum: 0, default: 10 },
      },
      required: ["op", "group_id", "node_ids"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Convert nodes into a native subgraph. Must be the last operation; inspect again for remapped node IDs.",
      properties: {
        op: { const: "convert_to_subgraph" },
        node_ids: {
          type: "array",
          items: NODE_REFERENCE_SCHEMA,
          minItems: 1,
        },
        temp_ref: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
        },
        title: { type: "string" },
      },
      required: ["op", "node_ids", "temp_ref"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Unpack a native subgraph instance into this graph. Must be the last operation; inspect again for remapped node IDs.",
      properties: {
        op: { const: "unpack_subgraph" },
        node_id: NODE_REFERENCE_SCHEMA,
      },
      required: ["op", "node_id"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Add a port to the active subgraph definition and all its shared instances.",
      properties: {
        op: { const: "add_subgraph_port" },
        direction: { type: "string", enum: ["input", "output"] },
        name: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
      },
      required: ["op", "direction", "name", "type"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Change a subgraph port's display label; its name remains the stable connection key.",
      properties: {
        op: { const: "rename_subgraph_port" },
        direction: { type: "string", enum: ["input", "output"] },
        name: { type: "string", minLength: 1 },
        label: { type: "string" },
      },
      required: ["op", "direction", "name", "label"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Remove a port from the active subgraph definition and all its shared instances.",
      properties: {
        op: { const: "remove_subgraph_port" },
        direction: { type: "string", enum: ["input", "output"] },
        name: { type: "string", minLength: 1 },
      },
      required: ["op", "direction", "name"],
      additionalProperties: false,
    },
  ],
};

const TOOL_DEFINITIONS = [
  {
    name: "list_instances",
    description: "Discover local ComfyUI instances, connection status, last focus times, and their active canvases.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "inspect_canvas",
    description: "Inspect a compact live ComfyUI canvas, subgraph navigation and ports, or details for native node and group refs.",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: INSTANCE_ID_SCHEMA,
        canvas_id: {
          type: "string",
          description: "Opaque canvas identity returned by an earlier inspection.",
        },
        refs: {
          type: "array",
          items: CANVAS_REFERENCE_SCHEMA,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "present_canvas",
    description: "Navigate to a native graph, select and optionally fit its items without modifying the workflow.",
    inputSchema: {
      type: "object",
      properties: {
        canvas_id: { type: "string" },
        graph_id: {
          type: "string",
          minLength: 1,
          description: "Native graph ID from inspect_canvas; navigate to this graph before selecting refs.",
        },
        refs: {
          type: "array",
          items: CANVAS_REFERENCE_SCHEMA,
        },
        selection: { type: "string", enum: ["replace", "add"] },
        fit_view: { type: "boolean" },
      },
      required: ["canvas_id", "refs", "selection", "fit_view"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "search_nodes",
    description: "Search the node types installed in ComfyUI.",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: INSTANCE_ID_SCHEMA,
        canvas_id: { type: "string", description: "Use the instance that owns this inspected canvas." },
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "inspect_node_type",
    description: "Inspect the complete native ComfyUI schema for one installed node type.",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: INSTANCE_ID_SCHEMA,
        canvas_id: { type: "string", description: "Use the instance that owns this inspected canvas." },
        class_type: { type: "string", minLength: 1 },
      },
      required: ["class_type"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "apply_canvas_patch",
    description: "Apply one atomic, undoable batch of changes to a live ComfyUI canvas.",
    inputSchema: {
      type: "object",
      properties: {
        canvas_id: { type: "string" },
        base_revision: { type: "string" },
        operations: {
          type: "array",
          minItems: 1,
          items: PATCH_OPERATION_SCHEMA,
        },
      },
      required: ["canvas_id", "base_revision", "operations"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error) {
  const value = { error };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

function commandUrl(baseUrl) {
  return `${baseUrl.replace(/\/$/, "")}/openbio-comfy-mcp/command`;
}

async function relayCommand(command, arguments_, { instance, router, fetchImpl }) {
  const baseUrl = instance.base_url;
  const { instance_id: _instanceId, ...canvasArguments } = arguments_;
  const canvas_id = instance.native_canvas_id;
  if (canvas_id !== undefined) canvasArguments.canvas_id = canvas_id;
  let response;
  try {
    response = await fetchImpl(commandUrl(baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(instance.expected_instance_id ? { instance_id: instance.expected_instance_id } : {}),
        ...(canvas_id === undefined ? {} : { canvas_id }),
        command,
        arguments: canvasArguments,
      }),
    });
  } catch (error) {
    throw unavailableError(baseUrl, error);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new McpHostError(
      "COMFYUI_INVALID_RESPONSE",
      "ComfyUI returned invalid JSON for a canvas command.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!response.ok || body.error) {
    return toolError(body.error ?? {
      code: "COMFYUI_REQUEST_FAILED",
      message: `ComfyUI returned HTTP ${response.status}.`,
    });
  }
  return toolResult(router.bindResult(instance, body.result ?? body, body.instance_id));
}

export function createMcpServer({
  baseUrl = process.env.OPENBIO_COMFY_URL,
  registryDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  const router = createInstanceRouter({ baseUrl, registryDir, fetchImpl });
  const server = new Server(
    { name: "openbio-comfy-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Call inspect_canvas without refs for a compact live topology, then pass its native node or group refs back only when details are needed. Use search_nodes to find an installed class_type, then call inspect_node_type when its complete native schema is needed. Before applying a patch, reuse the inspection's canvas_id and revision as base_revision. Call present_canvas without a revision to navigate between live graphs or change selection and viewport; its optional graph_id accepts a node's subgraph_id or root_graph_id from inspection. Pass the current canvas_id and refs belonging to the destination graph, then use the returned canvas_id and inspect again after navigation. Native graph IDs are not installed class_type values. Read subgraph boundary node IDs and slot names from inspection and reuse connect/disconnect for boundary links. Subgraph edits affect the shared definition and all its instances. convert_to_subgraph and unpack_subgraph must be the last operation in a patch; inspect again afterward for remapped IDs. Each successful patch is one native ComfyUI undo transaction. The bridge never queues or executes a workflow and never saves it automatically. If the canvas is stale, inspect again instead of retrying the old patch. Use list_instances to discover local ComfyUI instances and their canvases. Without an explicit target, tools use the online instance with the most recent reported last_focused_at, even after focus returns to chat. If focus times are unavailable or tied, choose instance_id using list_instances. An explicit instance_id or canvas_id takes priority. Reuse the returned opaque canvas_id unchanged for all subsequent presentation and editing, including after navigation. Use that canvas_id with search_nodes and inspect_node_type to query the same instance. Canvas IDs include process identity: if an instance restarts, explicitly inspect the new instance; never retry a write on a different instance.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: arguments_ = {} } = request.params;
    try {
      if (name === "list_instances") {
        return toolResult(await router.listInstances());
      }
      if (name === "inspect_canvas" || name === "present_canvas" || name === "apply_canvas_patch") {
        const instance = await router.resolve(arguments_);
        return await relayCommand(name, arguments_, { instance, router, fetchImpl });
      }
      if (name === "search_nodes") {
        const instance = await router.resolve(arguments_);
        const value = await searchNodes(arguments_, { baseUrl: instance.base_url, fetchImpl });
        return toolResult(router.bindResult(instance, value));
      }
      if (name === "inspect_node_type") {
        const instance = await router.resolve(arguments_);
        const value = await inspectNodeType(arguments_, { baseUrl: instance.base_url, fetchImpl });
        return toolResult(router.bindResult(instance, value));
      }
    } catch (error) {
      if (error instanceof McpHostError) {
        return toolError({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      return toolError({
        code: "MCP_HOST_ERROR",
        message: "The OpenBio Comfy MCP host failed while handling the tool call.",
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    return {
      content: [{ type: "text", text: `Tool is not implemented: ${name}` }],
      isError: true,
    };
  });

  return server;
}
