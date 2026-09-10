import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../mcp_host/server.mjs";

const cliPath = fileURLToPath(new URL("../mcp_host/cli.mjs", import.meta.url));

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startFakeComfy(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function connectInMemory(t, baseUrl, options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ baseUrl, ...options });
  const client = new Client({ name: "openbio-comfy-mcp-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

test("stdio client can initialize, list tools, and inspect the live canvas", async (t) => {
  let received;
  const comfy = await startFakeComfy(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/openbio-comfy-mcp/command");
    received = await readJson(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      result: {
        canvas_id: "canvas-7",
        page_id: "page-1",
        workflow_id: "workflow-1",
        revision: "rev-4",
        nodes: [],
        links: [],
        selection: [],
        viewport: { offset: [0, 0], scale: 1 },
      },
    }));
  });
  t.after(() => comfy.close());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env: { ...process.env, OPENBIO_COMFY_URL: comfy.url },
    stderr: "pipe",
  });
  const client = new Client({ name: "openbio-comfy-mcp-test", version: "0.1.0" });
  t.after(() => client.close());

  await client.connect(transport);
  assert.match(
    client.getInstructions(),
    /without refs for a compact live topology.*native node or group refs.*queue_canvas.*never saves/s,
  );
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(({ name }) => name),
    [
      "list_instances",
      "inspect_canvas",
      "present_canvas",
      "search_nodes",
      "inspect_node_type",
      "apply_canvas_patch",
      "queue_canvas",
      "inspect_prompt",
      "wait_for_prompt",
    ],
  );
  const listInstancesTool = listed.tools.find(({ name }) => name === "list_instances");
  assert.deepEqual(listInstancesTool.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.deepEqual(listInstancesTool.annotations, { readOnlyHint: true, openWorldHint: false });
  const inspectTool = listed.tools.find(({ name }) => name === "inspect_canvas");
  assert.equal(inspectTool.inputSchema.properties.instance_id.type, "string");
  assert.deepEqual(inspectTool.inputSchema.properties.refs, {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["node", "group"] },
        id: { type: ["string", "integer"] },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
  });
  const presentTool = listed.tools.find(({ name }) => name === "present_canvas");
  assert.deepEqual(presentTool.inputSchema, {
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
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["node", "group"] },
            id: { type: ["string", "integer"] },
          },
          required: ["kind", "id"],
          additionalProperties: false,
        },
      },
      selection: { type: "string", enum: ["replace", "add"] },
      fit_view: { type: "boolean" },
    },
    required: ["canvas_id", "refs", "selection", "fit_view"],
    additionalProperties: false,
  });
  assert.deepEqual(presentTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const inspectNodeTypeTool = listed.tools.find(({ name }) => name === "inspect_node_type");
  assert.deepEqual(inspectNodeTypeTool.inputSchema.properties.class_type, { type: "string", minLength: 1 });
  assert.deepEqual(inspectNodeTypeTool.inputSchema.required, ["class_type"]);
  assert.equal(inspectNodeTypeTool.inputSchema.additionalProperties, false);
  for (const name of ["search_nodes", "inspect_node_type"]) {
    const { inputSchema } = listed.tools.find((tool) => tool.name === name);
    assert.equal(inputSchema.properties.instance_id.type, "string");
    assert.equal(inputSchema.properties.canvas_id.type, "string");
  }
  assert.deepEqual(inspectNodeTypeTool.annotations, {
    readOnlyHint: true,
    openWorldHint: false,
  });

  const result = await client.callTool({
    name: "inspect_canvas",
    arguments: {
      canvas_id: "canvas-7",
      refs: [{ kind: "node", id: "31" }],
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.canvas_id, "canvas-7");
  assert.equal(result.structuredContent.instance_id, "configured");
  assert.deepEqual(received, {
    canvas_id: "canvas-7",
    command: "inspect_canvas",
    arguments: {
      canvas_id: "canvas-7",
      refs: [{ kind: "node", id: "31" }],
    },
  });
});

test("present_canvas sends presentation state to the selected live canvas", async (t) => {
  let received;
  const comfy = await startFakeComfy(async (request, response) => {
    received = await readJson(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      result: {
        canvas_id: "canvas-7",
        selection: [
          { kind: "node", id: "31" },
          { kind: "group", id: "6" },
        ],
        viewport: { offset: [120, 80], scale: 0.75 },
      },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);
  const arguments_ = {
    canvas_id: "canvas-7",
    refs: [
      { kind: "node", id: "31" },
      { kind: "group", id: "6" },
    ],
    selection: "replace",
    fit_view: true,
  };

  const result = await client.callTool({
    name: "present_canvas",
    arguments: arguments_,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    instance_id: "configured",
    canvas_id: "canvas-7",
    selection: [
      { kind: "node", id: "31" },
      { kind: "group", id: "6" },
    ],
    viewport: { offset: [120, 80], scale: 0.75 },
  });
  assert.deepEqual(received, {
    canvas_id: "canvas-7",
    command: "present_canvas",
    arguments: arguments_,
  });
});

test("present_canvas relays graph navigation and returns the new canvas identity", async (t) => {
  let received;
  const comfy = await startFakeComfy(async (request, response) => {
    received = await readJson(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      result: {
        canvas_id: "canvas-subgraph",
        selection: [],
        viewport: { offset: [0, 0], scale: 1 },
      },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);
  const arguments_ = {
    canvas_id: "canvas-root",
    graph_id: "subgraph-1",
    refs: [],
    selection: "replace",
    fit_view: false,
  };

  const result = await client.callTool({ name: "present_canvas", arguments: arguments_ });

  assert.equal(result.structuredContent.canvas_id, "canvas-subgraph");
  assert.deepEqual(received, {
    canvas_id: "canvas-root",
    command: "present_canvas",
    arguments: arguments_,
  });
});

test("apply_canvas_patch sends one ordered patch to the selected live canvas", async (t) => {
  let received;
  const comfy = await startFakeComfy(async (request, response) => {
    received = await readJson(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      canvas_id: "canvas-7",
      revision: "rev-5",
      id_map: { load: 42 },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);
  const operations = [{
    op: "add_node",
    temp_ref: "load",
    class_type: "OpenBioLoadH5AD",
    pos: [100, 200],
  }, {
    op: "add_group",
    temp_ref: "inputs",
    title: "Inputs",
    bounding: [80, 160, 380, 240],
  }, {
    op: "move_group",
    group_id: "inputs",
    delta: [-8060, 2000],
  }];

  const result = await client.callTool({
    name: "apply_canvas_patch",
    arguments: {
      canvas_id: "canvas-7",
      base_revision: "rev-4",
      operations,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    instance_id: "configured",
    canvas_id: "canvas-7",
    revision: "rev-5",
    id_map: { load: 42 },
  });
  assert.deepEqual(received, {
    canvas_id: "canvas-7",
    command: "apply_canvas_patch",
    arguments: {
      canvas_id: "canvas-7",
      base_revision: "rev-4",
      operations,
    },
  });
});

test("queue_canvas sends the live-canvas queue command and returns prompt_id", async (t) => {
  let received;
  const comfy = await startFakeComfy(async (request, response) => {
    received = await readJson(request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      result: {
        canvas_id: "canvas-7",
        revision: "rev-4",
        prompt_id: "prompt-9",
        number: 2,
      },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);

  const result = await client.callTool({
    name: "queue_canvas",
    arguments: { canvas_id: "canvas-7", base_revision: "rev-4", batch_count: 1 },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    instance_id: "configured",
    canvas_id: "canvas-7",
    revision: "rev-4",
    prompt_id: "prompt-9",
    number: 2,
  });
  assert.deepEqual(received, {
    canvas_id: "canvas-7",
    command: "queue_canvas",
    arguments: {
      canvas_id: "canvas-7",
      base_revision: "rev-4",
      batch_count: 1,
    },
  });
});

test("inspect_prompt maps output paths and view URLs from the prompt status route", async (t) => {
  const requests = [];
  const comfy = await startFakeComfy(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      result: {
        prompt_id: "prompt-9",
        status: "completed",
        outputs: [{
          node_id: "9",
          filename: "ComfyUI_00001_.png",
          subfolder: "",
          type: "output",
          path: "C:\\\\ComfyUI\\\\output\\\\ComfyUI_00001_.png",
        }],
      },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);

  const result = await client.callTool({
    name: "inspect_prompt",
    arguments: { canvas_id: "canvas-7", prompt_id: "prompt-9" },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "completed");
  assert.equal(result.structuredContent.outputs[0].filename, "ComfyUI_00001_.png");
  assert.match(result.structuredContent.outputs[0].view_url, /\/view\?filename=ComfyUI_00001_\.png/);
  assert.deepEqual(requests, [{ method: "GET", url: "/openbio-comfy-mcp/prompt/prompt-9" }]);
});

test("relay errors keep their code and details in the MCP tool result", async (t) => {
  const comfy = await startFakeComfy(async (_request, response) => {
    response.statusCode = 409;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: false,
      error: {
        code: "STALE_REVISION",
        message: "The canvas changed after inspection.",
        details: { expected: "rev-4", actual: "rev-5" },
      },
    }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);

  const result = await client.callTool({
    name: "apply_canvas_patch",
    arguments: {
      canvas_id: "canvas-7",
      base_revision: "rev-4",
      operations: [{ op: "remove_node", node_id: 12 }],
    },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "STALE_REVISION",
      message: "The canvas changed after inspection.",
      details: { expected: "rev-4", actual: "rev-5" },
    },
  });
  assert.match(result.content[0].text, /STALE_REVISION/);
});

test("an unavailable ComfyUI is reported as a tool error", async (t) => {
  const client = await connectInMemory(t, "http://127.0.0.1:1");

  const result = await client.callTool({
    name: "inspect_canvas",
    arguments: {},
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "COMFYUI_UNAVAILABLE");
  assert.match(result.structuredContent.error.message, /127\.0\.0\.1:1/);
});

test("an HTTP failure is not misreported as a network outage", async (t) => {
  const comfy = await startFakeComfy(async (_request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: "catalog failed" }));
  });
  t.after(() => comfy.close());
  const client = await connectInMemory(t, comfy.url);

  const result = await client.callTool({
    name: "search_nodes",
    arguments: { query: "Load H5AD" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "COMFYUI_HTTP_ERROR");
  assert.deepEqual(result.structuredContent.error.details, { status: 500 });
});

test("an internal host exception is not misreported as a network outage", async (t) => {
  const client = await connectInMemory(t, "http://127.0.0.1:8188", {
    fetchImpl: async () => {
      const body = {};
      Object.defineProperty(body, "error", {
        get() { throw new Error("implementation bug"); },
      });
      return { ok: true, status: 200, async json() { return body; } };
    },
  });

  const result = await client.callTool({
    name: "inspect_canvas",
    arguments: {},
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "MCP_HOST_ERROR");
});

test("tools/list advertises the exact supported GraphPatch operations", async (t) => {
  const client = await connectInMemory(t, "http://127.0.0.1:1");
  const listed = await client.listTools();
  const applyTool = listed.tools.find(({ name }) => name === "apply_canvas_patch");
  const variants = applyTool.inputSchema.properties.operations.items.oneOf;

  assert.deepEqual(
    variants.map((variant) => ({
      op: variant.properties.op.const,
      fields: Object.keys(variant.properties),
      required: variant.required,
      additionalProperties: variant.additionalProperties,
    })),
    [
      {
        op: "add_node",
        fields: ["op", "temp_ref", "class_type", "pos"],
        required: ["op", "temp_ref", "class_type"],
        additionalProperties: false,
      },
      {
        op: "remove_node",
        fields: ["op", "node_id"],
        required: ["op", "node_id"],
        additionalProperties: false,
      },
      {
        op: "set_input",
        fields: ["op", "node_id", "input_name", "value"],
        required: ["op", "node_id", "input_name", "value"],
        additionalProperties: false,
      },
      {
        op: "connect",
        fields: ["op", "source", "output_name", "target", "input_name"],
        required: ["op", "source", "output_name", "target", "input_name"],
        additionalProperties: false,
      },
      {
        op: "disconnect",
        fields: ["op", "target", "input_name"],
        required: ["op", "target", "input_name"],
        additionalProperties: false,
      },
      {
        op: "move_node",
        fields: ["op", "node_id", "pos"],
        required: ["op", "node_id", "pos"],
        additionalProperties: false,
      },
      {
        op: "add_group",
        fields: ["op", "temp_ref", "title", "bounding", "color", "pinned"],
        required: ["op", "temp_ref", "title"],
        additionalProperties: false,
      },
      {
        op: "update_group",
        fields: ["op", "group_id", "title", "bounding", "color", "pinned"],
        required: ["op", "group_id"],
        additionalProperties: false,
      },
      {
        op: "move_group",
        fields: ["op", "group_id", "delta"],
        required: ["op", "group_id", "delta"],
        additionalProperties: false,
      },
      {
        op: "remove_group",
        fields: ["op", "group_id"],
        required: ["op", "group_id"],
        additionalProperties: false,
      },
      {
        op: "fit_group_to_nodes",
        fields: ["op", "group_id", "node_ids", "padding"],
        required: ["op", "group_id", "node_ids"],
        additionalProperties: false,
      },
      {
        op: "convert_to_subgraph",
        fields: ["op", "node_ids", "temp_ref", "title"],
        required: ["op", "node_ids", "temp_ref"],
        additionalProperties: false,
      },
      {
        op: "unpack_subgraph",
        fields: ["op", "node_id"],
        required: ["op", "node_id"],
        additionalProperties: false,
      },
      {
        op: "add_subgraph_port",
        fields: ["op", "direction", "name", "type"],
        required: ["op", "direction", "name", "type"],
        additionalProperties: false,
      },
      {
        op: "rename_subgraph_port",
        fields: ["op", "direction", "name", "label"],
        required: ["op", "direction", "name", "label"],
        additionalProperties: false,
      },
      {
        op: "remove_subgraph_port",
        fields: ["op", "direction", "name"],
        required: ["op", "direction", "name"],
        additionalProperties: false,
      },
    ],
  );
  const conversion = variants.find(({ properties }) => properties.op.const === "convert_to_subgraph");
  assert.deepEqual(conversion.properties.node_ids, {
    type: "array",
    items: { type: ["string", "integer"] },
    minItems: 1,
  });
  assert.deepEqual(conversion.properties.temp_ref, {
    type: "string",
    pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
  });
  for (const variant of variants.filter(({ properties }) => properties.op.const.endsWith("subgraph_port"))) {
    assert.deepEqual(variant.properties.direction, { type: "string", enum: ["input", "output"] });
    assert.deepEqual(variant.properties.name, { type: "string", minLength: 1 });
  }
  const addPort = variants.find(({ properties }) => properties.op.const === "add_subgraph_port");
  assert.deepEqual(addPort.properties.type, { type: "string", minLength: 1 });
});
