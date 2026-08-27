import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { McpHostError, unavailableError } from "./errors.mjs";
import { inspectNodeType, searchNodes } from "./search_nodes.mjs";

const NODE_REFERENCE_SCHEMA = { type: ["string", "integer"] };
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
  ],
};

const TOOL_DEFINITIONS = [
  {
    name: "inspect_canvas",
    description: "Inspect a compact live ComfyUI canvas, or details for native node and group refs.",
    inputSchema: {
      type: "object",
      properties: {
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
    description: "Select and optionally fit native items on a live ComfyUI canvas without modifying the workflow.",
    inputSchema: {
      type: "object",
      properties: {
        canvas_id: { type: "string" },
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

async function relayCommand(command, arguments_, { baseUrl, fetchImpl }) {
  const { canvas_id } = arguments_;
  let response;
  try {
    response = await fetchImpl(commandUrl(baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(canvas_id === undefined ? {} : { canvas_id }),
        command,
        arguments: arguments_,
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
  return toolResult(body.result ?? body);
}

export function createMcpServer({
  baseUrl = process.env.OPENBIO_COMFY_URL ?? "http://127.0.0.1:8188",
  fetchImpl = globalThis.fetch,
} = {}) {
  const server = new Server(
    { name: "openbio-comfy-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Call inspect_canvas without refs for a compact live topology, then pass its native node or group refs back only when details are needed. Use search_nodes to find an installed class_type, then call inspect_node_type when its complete native schema is needed. Before applying a patch, reuse the inspection's canvas_id and revision as base_revision. Call present_canvas without a revision to change only the live selection or viewport. Each successful patch is one native ComfyUI undo transaction. The bridge never queues or executes a workflow and never saves it automatically. If the canvas is stale, inspect again instead of retrying the old patch.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: arguments_ = {} } = request.params;
    try {
      if (name === "inspect_canvas") {
        return await relayCommand(name, arguments_, { baseUrl, fetchImpl });
      }
      if (name === "present_canvas") {
        return await relayCommand(name, arguments_, { baseUrl, fetchImpl });
      }
      if (name === "search_nodes") {
        const value = await searchNodes(arguments_, { baseUrl, fetchImpl });
        return toolResult(value);
      }
      if (name === "inspect_node_type") {
        const value = await inspectNodeType(arguments_, { baseUrl, fetchImpl });
        return toolResult(value);
      }
      if (name === "apply_canvas_patch") {
        return await relayCommand(name, arguments_, { baseUrl, fetchImpl });
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
