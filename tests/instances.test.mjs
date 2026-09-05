import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../mcp_host/server.mjs";

async function registry(t) {
  const directory = await mkdtemp(join(tmpdir(), "openbio-instances-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function register(directory, instance, overrides = {}) {
  const record = {
    instance_id: instance.instance_id,
    base_url: instance.url,
    pid: process.pid,
    updated_at: Date.now() / 1000,
    ...overrides,
  };
  await writeFile(join(directory, `${record.instance_id}.json`), JSON.stringify(record));
}

async function comfy(t, instanceId) {
  const state = {
    instance_id: instanceId,
    canvas_id: `canvas-${instanceId}`,
    focused: true,
    requests: [],
    commands: [],
  };
  const server = createServer(async (request, response) => {
    state.requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/openbio-comfy-mcp/health") {
      response.end(JSON.stringify({
        ok: true,
        instance_id: state.instance_id,
        canvases: state.canvases ?? [{
          canvas_id: state.canvas_id,
          page_id: `page-${instanceId}`,
          workflow_id: `workflow-${instanceId}`,
          focused: state.focused,
          last_focused_at: state.last_focused_at,
          href: state.url,
        }],
      }));
      return;
    }
    if (request.url.startsWith("/object_info")) {
      response.end(JSON.stringify({ LocalNode: {
        display_name: `Local Node ${instanceId}`,
        description: `Installed in ${instanceId}`,
        input: { required: {} },
        output: [],
      } }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.commands.push(message);
    if (message.instance_id !== state.instance_id) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: {
        code: "INSTANCE_MISMATCH",
        message: "This port belongs to a different ComfyUI process.",
      } }));
      return;
    }
    if (message.command === "present_canvas" && message.arguments.graph_id) {
      state.canvas_id = `canvas-${instanceId}-${message.arguments.graph_id}`;
    }
    response.end(JSON.stringify({ ok: true, result: {
      canvas_id: message.arguments.graph_id ? state.canvas_id : message.canvas_id ?? state.canvas_id,
      revision: `revision-${instanceId}`,
      nodes: [],
      links: [],
    } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  t.after(state.close);
  return state;
}

async function connect(t, registryDir, options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ registryDir, ...options });
  const client = new Client({ name: "instances-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

async function call(client, name, arguments_ = {}) {
  return client.callTool({ name, arguments: arguments_ });
}

function patch(canvasId) {
  return {
    canvas_id: canvasId,
    base_revision: "revision-1",
    operations: [{ op: "move_node", node_id: 1, pos: [20, 30] }],
  };
}

test("discovery reads fresh local registrations and detects instances added after connection", async (t) => {
  const directory = await registry(t);
  const first = await comfy(t, "first");
  const second = await comfy(t, "second");
  const stopped = await comfy(t, "stopped");
  await stopped.close();
  await register(directory, first);
  await register(directory, stopped);
  await register(directory, first, { instance_id: "expired", updated_at: Date.now() / 1000 - 60 });
  await register(directory, first, { instance_id: "remote", base_url: "https://example.com:8188" });
  await writeFile(join(directory, "unfinished.json"), "{");
  const client = await connect(t, directory);

  const listed = await call(client, "list_instances");
  assert.equal(listed.isError, undefined);
  assert.deepEqual(listed.structuredContent.instances.map(({ instance_id, status }) => ({ instance_id, status }))
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id)), [
    { instance_id: "first", status: "online" },
    { instance_id: "stopped", status: "unavailable" },
  ]);
  const online = listed.structuredContent.instances.find(({ instance_id }) => instance_id === "first");
  assert.equal(online.base_url, first.url);
  assert.notEqual(online.canvases[0].canvas_id, first.canvas_id);
  assert.deepEqual(listed.structuredContent.instances.find(({ instance_id }) => instance_id === "stopped").canvases, []);
  const inspected = await call(client, "inspect_canvas");
  assert.equal(inspected.structuredContent.instance_id, "first");
  assert.equal(inspected.structuredContent.canvas_id, online.canvases[0].canvas_id);

  await register(directory, second);
  const updated = await call(client, "list_instances");
  assert.equal(updated.structuredContent.instances.filter(({ status }) => status === "online").length, 2);
  for (const [name, args] of [["inspect_canvas", {}], ["search_nodes", { query: "Local" }]]) {
    const ambiguous = await call(client, name, args);
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.structuredContent.error.code, "AMBIGUOUS_INSTANCE");
  }
  assert.equal(first.commands.length, 1);
  assert.equal(second.commands.length, 0);
});

test("latest focus selects an instance and canvas after blur while explicit targets stay bound", async (t) => {
  const directory = await registry(t);
  const first = await comfy(t, "first");
  const second = await comfy(t, "second");
  first.focused = false;
  first.last_focused_at = 1000;
  second.canvases = [
    { canvas_id: "older-second-canvas", focused: false, last_focused_at: 1500 },
    { canvas_id: second.canvas_id, focused: false, last_focused_at: 2000 },
  ];
  await register(directory, first);
  await register(directory, second);
  const client = await connect(t, directory);

  const listed = await call(client, "list_instances");
  const instances = listed.structuredContent.instances;
  assert.equal(instances.find(({ instance_id }) => instance_id === "first").last_focused_at, 1000);
  assert.equal(instances.find(({ instance_id }) => instance_id === "second").last_focused_at, 2000);
  assert.ok(instances.every(({ canvases }) => canvases.every(({ focused }) => focused === false)));

  const inspected = await call(client, "inspect_canvas");
  assert.equal(inspected.isError, undefined);
  assert.equal(inspected.structuredContent.instance_id, "second");
  assert.equal(second.commands.at(-1).canvas_id, second.canvas_id);
  assert.equal(second.commands.at(-1).arguments.canvas_id, second.canvas_id);
  const selectedCanvas = inspected.structuredContent.canvas_id;
  assert.equal(selectedCanvas, instances.find(({ instance_id }) => instance_id === "second").canvases[1].canvas_id);
  const search = await call(client, "search_nodes", { query: "Local" });
  assert.equal(search.structuredContent.instance_id, "second");
  assert.equal(search.structuredContent.nodes[0].description, "Installed in second");

  const explicit = await call(client, "inspect_canvas", { instance_id: "first" });
  assert.equal(explicit.structuredContent.instance_id, "first");
  first.last_focused_at = 3000;
  const latest = await call(client, "inspect_canvas");
  assert.equal(latest.structuredContent.instance_id, "first");
  const patched = await call(client, "apply_canvas_patch", patch(selectedCanvas));
  assert.equal(patched.isError, undefined);
  assert.equal(patched.structuredContent.instance_id, "second");
  assert.equal(patched.structuredContent.canvas_id, selectedCanvas);
  assert.equal(second.commands.at(-1).canvas_id, second.canvas_id);
  const boundSearch = await call(client, "search_nodes", { query: "Local", canvas_id: selectedCanvas });
  assert.equal(boundSearch.structuredContent.instance_id, "second");

  const commandCount = first.commands.length + second.commands.length;
  second.canvases[0].last_focused_at = null;
  for (const timestamp of [null, 3000]) {
    first.last_focused_at = timestamp;
    second.canvases[1].last_focused_at = timestamp;
    for (const [name, args] of [["inspect_canvas", {}], ["search_nodes", { query: "Local" }]]) {
      const ambiguous = await call(client, name, args);
      assert.equal(ambiguous.isError, true);
      assert.equal(ambiguous.structuredContent.error.code, "AMBIGUOUS_INSTANCE");
    }
  }
  assert.equal(first.commands.length + second.commands.length, commandCount);
});

test("concurrent inspections bind edits, catalogs, and subgraph navigation to their own instance", async (t) => {
  const directory = await registry(t);
  const first = await comfy(t, "first");
  const second = await comfy(t, "second");
  await register(directory, first);
  await register(directory, second);
  const client = await connect(t, directory);

  const listed = await call(client, "list_instances");
  const firstCanvas = listed.structuredContent.instances.find(({ instance_id }) => instance_id === "first").canvases[0].canvas_id;
  const secondCanvas = listed.structuredContent.instances.find(({ instance_id }) => instance_id === "second").canvases[0].canvas_id;
  const conflict = await call(client, "search_nodes", {
    instance_id: "second", canvas_id: firstCanvas, query: "Local",
  });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, "INSTANCE_MISMATCH");
  assert.equal(second.requests.includes("/object_info"), false);

  const search = await call(client, "search_nodes", { canvas_id: firstCanvas, query: "Local" });
  assert.equal(search.structuredContent.instance_id, "first");
  assert.equal(search.structuredContent.nodes[0].description, "Installed in first");
  const inspected = await Promise.all([
    call(client, "inspect_canvas", { instance_id: "first" }),
    call(client, "inspect_canvas", { canvas_id: secondCanvas }),
  ]);
  assert.deepEqual(inspected.map(({ structuredContent }) => structuredContent.instance_id), ["first", "second"]);
  assert.deepEqual(inspected.map(({ structuredContent }) => structuredContent.canvas_id), [firstCanvas, secondCanvas]);
  const patched = await Promise.all(inspected.map(({ structuredContent }) =>
    call(client, "apply_canvas_patch", patch(structuredContent.canvas_id))));
  assert.deepEqual(patched.map(({ structuredContent }) => structuredContent.instance_id), ["first", "second"]);
  assert.deepEqual(patched.map(({ structuredContent }) => structuredContent.canvas_id), [firstCanvas, secondCanvas]);
  for (const instance of [first, second]) {
    assert.deepEqual(instance.commands.map(({ command }) => command), ["inspect_canvas", "apply_canvas_patch"]);
    for (const command of instance.commands) {
      assert.equal(command.instance_id, instance.instance_id);
      assert.equal(Object.hasOwn(command.arguments, "instance_id"), false);
    }
    assert.equal(instance.commands[1].canvas_id, instance.canvas_id);
    assert.equal(instance.commands[1].arguments.canvas_id, instance.canvas_id);
  }
  assert.equal(second.commands[0].canvas_id, second.canvas_id);
  assert.equal(second.commands[0].arguments.canvas_id, second.canvas_id);

  const schema = await call(client, "inspect_node_type", { instance_id: "second", class_type: "LocalNode" });
  assert.equal(schema.structuredContent.instance_id, "second");
  assert.equal(schema.structuredContent.schema.description, "Installed in second");
  assert.equal(first.requests.includes("/object_info/LocalNode"), false);
  assert.equal(second.requests.includes("/object_info"), false);

  const navigation = await call(client, "present_canvas", {
    canvas_id: inspected[0].structuredContent.canvas_id,
    graph_id: "subgraph",
    refs: [],
    selection: "replace",
    fit_view: false,
  });
  assert.equal(navigation.structuredContent.instance_id, "first");
  assert.notEqual(navigation.structuredContent.canvas_id, firstCanvas);
  assert.notEqual(navigation.structuredContent.canvas_id, first.canvas_id);
  const edited = await call(client, "apply_canvas_patch", patch(navigation.structuredContent.canvas_id));
  assert.equal(edited.structuredContent.instance_id, "first");
  assert.equal(edited.structuredContent.canvas_id, navigation.structuredContent.canvas_id);
  assert.equal(first.commands.at(-1).canvas_id, "canvas-first-subgraph");
  assert.equal(first.commands.at(-1).arguments.canvas_id, "canvas-first-subgraph");
  assert.equal(second.commands.length, 2);

  const unknown = await call(client, "apply_canvas_patch", patch("unknown-canvas"));
  assert.equal(unknown.structuredContent.error.code, "NO_LIVE_CANVAS");
  assert.equal(first.commands.length, 4);
  assert.equal(second.commands.length, 2);

  const reconnected = await connect(t, directory);
  const resumedSearch = await call(reconnected, "search_nodes", {
    canvas_id: navigation.structuredContent.canvas_id, query: "Local",
  });
  assert.equal(resumedSearch.structuredContent.instance_id, "first");
  assert.equal(resumedSearch.structuredContent.nodes[0].description, "Installed in first");
  const resumedEdit = await call(reconnected, "apply_canvas_patch", patch(navigation.structuredContent.canvas_id));
  assert.equal(resumedEdit.structuredContent.instance_id, "first");
  assert.equal(first.commands.at(-1).canvas_id, "canvas-first-subgraph");
  assert.equal(first.commands.length, 5);
  assert.equal(second.commands.length, 2);
});

test("restarting an instance with the same native canvas permits fresh inspection while old canvas handles remain unavailable", async (t) => {
  const directory = await registry(t);
  const first = await comfy(t, "first");
  const second = await comfy(t, "second");
  await register(directory, first);
  await register(directory, second);
  const client = await connect(t, directory);
  const inspected = await call(client, "inspect_canvas", { instance_id: "first" });

  first.instance_id = "replacement";
  const replaced = await call(client, "apply_canvas_patch", patch(inspected.structuredContent.canvas_id));
  assert.equal(replaced.isError, true);
  assert.ok(["INSTANCE_UNAVAILABLE", "INSTANCE_MISMATCH"].includes(replaced.structuredContent.error.code));
  assert.equal(first.commands.filter(({ command }) => command === "apply_canvas_patch").length, 0);
  assert.equal(second.commands.length, 0);

  await register(directory, first);
  await rm(join(directory, "first.json"));
  const fresh = await call(client, "inspect_canvas", { instance_id: "replacement" });
  assert.equal(fresh.isError, undefined);
  assert.equal(fresh.structuredContent.instance_id, "replacement");
  assert.notEqual(fresh.structuredContent.canvas_id, inspected.structuredContent.canvas_id);
  const oldCanvas = await call(client, "apply_canvas_patch", patch(inspected.structuredContent.canvas_id));
  assert.equal(oldCanvas.isError, true);
  assert.equal(oldCanvas.structuredContent.error.code, "INSTANCE_UNAVAILABLE");
  assert.equal(first.commands.filter(({ command }) => command === "apply_canvas_patch").length, 0);

  const edited = await call(client, "apply_canvas_patch", patch(fresh.structuredContent.canvas_id));
  assert.equal(edited.isError, undefined);
  assert.equal(edited.structuredContent.instance_id, "replacement");
  assert.equal(first.commands.at(-1).instance_id, "replacement");
  assert.equal(first.commands.at(-1).canvas_id, "canvas-first");
  assert.equal(first.commands.at(-1).arguments.canvas_id, "canvas-first");

  await first.close();
  const disconnected = await call(client, "apply_canvas_patch", patch(fresh.structuredContent.canvas_id));
  assert.equal(disconnected.isError, true);
  assert.equal(disconnected.structuredContent.error.code, "INSTANCE_UNAVAILABLE");
  assert.equal(second.commands.length, 0);
});

test("an empty registry keeps the default localhost connection without probing other ports", async (t) => {
  const directory = await registry(t);
  const requests = [];
  const client = await connect(t, directory, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() {
        return { result: { canvas_id: "default-canvas", revision: "revision-1" } };
      } };
    },
  });

  const inspected = await call(client, "inspect_canvas");
  assert.equal(inspected.isError, undefined);
  assert.equal(inspected.structuredContent.instance_id, "default");
  assert.deepEqual(requests.map(({ url }) => url), ["http://127.0.0.1:8188/openbio-comfy-mcp/command"]);
  assert.equal(Object.hasOwn(JSON.parse(requests[0].options.body), "instance_id"), false);
});

test("fallback and configured canvas handles retain process identity when registration appears or the process changes", async (t) => {
  const directory = await registry(t);
  const baseUrl = "http://127.0.0.1:8188";
  let processId = "process-a";
  const commands = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/health")) {
      return { ok: true, status: 200, async json() {
        return { ok: true, instance_id: processId, canvases: [{ canvas_id: "native-same" }] };
      } };
    }
    commands.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() {
      return { ok: true, instance_id: processId, result: { canvas_id: "native-same", revision: "revision-1" } };
    } };
  };
  const client = await connect(t, directory, { fetchImpl });
  const initial = await call(client, "inspect_canvas");
  assert.equal(initial.structuredContent.instance_id, "default");
  assert.notEqual(initial.structuredContent.canvas_id, "native-same");

  await register(directory, { instance_id: processId, url: baseUrl });
  const registered = await call(client, "inspect_canvas", { instance_id: processId });
  assert.equal(registered.structuredContent.instance_id, processId);
  assert.notEqual(registered.structuredContent.canvas_id, initial.structuredContent.canvas_id);
  const fixedClient = await connect(t, directory, { baseUrl, fetchImpl });
  const configured = await call(fixedClient, "inspect_canvas");
  assert.equal(configured.structuredContent.instance_id, "configured");
  assert.notEqual(configured.structuredContent.canvas_id, "native-same");

  for (const [target, inspected] of [[client, initial], [client, registered], [fixedClient, configured]]) {
    const edited = await call(target, "apply_canvas_patch", patch(inspected.structuredContent.canvas_id));
    assert.equal(edited.isError, undefined);
    assert.equal(edited.structuredContent.instance_id, inspected.structuredContent.instance_id);
    assert.equal(commands.at(-1).instance_id, "process-a");
    assert.equal(commands.at(-1).canvas_id, "native-same");
    assert.equal(commands.at(-1).arguments.canvas_id, "native-same");
  }

  processId = "process-b";
  for (const [target, inspected] of [[client, initial], [fixedClient, configured]]) {
    const stale = await call(target, "apply_canvas_patch", patch(inspected.structuredContent.canvas_id));
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.code, "INSTANCE_UNAVAILABLE");
  }
  assert.equal(commands.filter(({ command }) => command === "apply_canvas_patch").length, 3);
});
