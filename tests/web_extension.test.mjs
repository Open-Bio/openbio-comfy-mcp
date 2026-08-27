import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_EVENT,
  EXTENSION_NAME,
  REPLY_PATH,
  SESSION_PATH,
  createLiveCanvasWebExtension,
} from "../web/extension.mjs";
import { createLiveCanvas } from "../web/canvas_bridge.mjs";
import { createCanvasFixture } from "./helpers/canvas_fixture.mjs";

function response() {
  return { ok: true, async json() { return {}; } };
}

function createWebFixture() {
  const graphFixture = createCanvasFixture();
  const requests = [];
  const customListeners = new Map();
  const eventListeners = new Map();
  const windowListeners = new Map();
  const canvasListeners = new Map();
  const workflowSubscribers = new Set();
  let focused = true;
  let intervalCallback;

  const api = {
    clientId: "client-a",
    addCustomEventListener(name, listener) { customListeners.set(name, listener); },
    removeCustomEventListener(name) { customListeners.delete(name); },
    addEventListener(name, listener) { eventListeners.set(name, listener); },
    removeEventListener(name) { eventListeners.delete(name); },
    async fetchApi(path, options) {
      requests.push({ path, method: options.method, body: JSON.parse(options.body) });
      return response();
    },
  };
  const windowRef = {
    location: { href: "http://127.0.0.1:8188/#workflow-123" },
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name) { windowListeners.delete(name); },
  };
  graphFixture.canvas.canvas = {
    addEventListener(name, listener) { canvasListeners.set(name, listener); },
    removeEventListener(name) { canvasListeners.delete(name); },
  };
  graphFixture.app.extensionManager.workflow.$subscribe = (listener) => {
    workflowSubscribers.add(listener);
    return () => workflowSubscribers.delete(listener);
  };
  const documentRef = {
    visibilityState: "visible",
    hasFocus() { return focused; },
    addEventListener(name, listener) { eventListeners.set(`document:${name}`, listener); },
    removeEventListener(name) { eventListeners.delete(`document:${name}`); },
  };
  const extension = createLiveCanvasWebExtension({
    app: graphFixture.app,
    api,
    LiteGraph: graphFixture.LiteGraph,
    pageId: "page-a",
    windowRef,
    documentRef,
    setIntervalFn(callback) { intervalCallback = callback; return 11; },
    clearIntervalFn() {},
  });

  return {
    ...graphFixture,
    api,
    extension,
    requests,
    customListeners,
    eventListeners,
    windowListeners,
    canvasListeners,
    async workflowChanged() {
      await Promise.all([...workflowSubscribers].map((listener) => listener()));
    },
    setFocused(value) { focused = value; },
    heartbeat() { return intervalCallback(); },
  };
}

test("web extension registers the visible page and answers inspect_canvas over ComfyUI events", async () => {
  const fixture = createWebFixture();
  assert.equal(fixture.extension.name, EXTENSION_NAME);

  await fixture.extension.setup();

  assert.deepEqual(fixture.requests[0], {
    path: SESSION_PATH,
    method: "POST",
    body: {
      page_id: "page-a",
      client_id: "client-a",
      workflow_id: "workflow-123",
      canvas_id: "page-a:workflow-123:canvas-root",
      focused: true,
      href: "http://127.0.0.1:8188/#workflow-123",
    },
  });
  const commandListener = fixture.customListeners.get(COMMAND_EVENT);
  assert.equal(typeof commandListener, "function");

  await commandListener({
    detail: {
      request_id: "request-1",
      page_id: "page-a",
      workflow_id: "workflow-123",
      canvas_id: "page-a:workflow-123:canvas-root",
      command: "inspect_canvas",
      arguments: { refs: [{ kind: "node", id: "7" }] },
    },
  });

  const reply = fixture.requests.at(-1);
  assert.equal(reply.path, REPLY_PATH);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.request_id, "request-1");
  assert.equal(reply.body.result.canvas_id, "page-a:workflow-123:canvas-root");
  assert.deepEqual(reply.body.result.items.map(({ kind, id }) => ({ kind, id })), [
    { kind: "node", id: "7" },
  ]);
});

test("heartbeat, focus and ComfyUI reconnect refresh the native session", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;

  await fixture.heartbeat();
  fixture.setFocused(false);
  await fixture.windowListeners.get("blur")();
  fixture.api.clientId = "client-reconnected";
  await fixture.eventListeners.get("reconnected")();

  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[0].body.focused, true);
  assert.equal(fixture.requests[1].body.focused, false);
  assert.equal(fixture.requests[2].body.client_id, "client-reconnected");
});

test("the native set-graph event immediately registers the newly active workflow", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;
  fixture.app.extensionManager.workflow.activeWorkflow = {
    path: "workflows/next.json",
    changeTracker: { activeState: { id: "workflow-next" } },
  };

  await fixture.canvasListeners.get("litegraph:set-graph")();

  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].body.workflow_id, "workflow-next");
  assert.equal(fixture.requests[0].body.canvas_id, "page-a:workflow-next:canvas-root");
});

test("the native workflow store immediately registers a root-to-root switch", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;
  fixture.app.extensionManager.workflow.activeWorkflow = {
    path: "workflows/next.json",
    changeTracker: { activeState: { id: "workflow-next" } },
  };

  await fixture.workflowChanged();

  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].body.workflow_id, "workflow-next");
  assert.equal(fixture.requests[0].body.canvas_id, "page-a:workflow-next:canvas-root");
});

test("apply failures are returned to MCP without reporting success", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;
  const commandListener = fixture.customListeners.get(COMMAND_EVENT);

  await commandListener({
    detail: {
      request_id: "request-failed",
      page_id: "page-a",
      workflow_id: "workflow-123",
      canvas_id: "page-a:workflow-123:canvas-root",
      command: "apply_canvas_patch",
      arguments: {
        canvas_id: "page-a:workflow-123:canvas-root",
        base_revision: "v1-stale",
        operations: [{ op: "move_node", node_id: "7", pos: [60, 100] }],
      },
    },
  });

  assert.deepEqual(fixture.requests.at(-1).body, {
    page_id: "page-a",
    request_id: "request-failed",
    ok: false,
    error: {
      code: "stale_revision",
      message: "The ComfyUI canvas changed; inspect it again",
      details: { expected: createLiveCanvas(fixture.app, fixture.LiteGraph, { pageId: "page-a" }).inspectCanvas().revision, received: "v1-stale" },
    },
  });
});

test("apply_canvas_patch uses the relay-selected canvas identity", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;
  const revision = createLiveCanvas(fixture.app, fixture.LiteGraph, { pageId: "page-a" })
    .inspectCanvas().revision;

  await fixture.customListeners.get(COMMAND_EVENT)({
    detail: {
      request_id: "request-apply",
      page_id: "page-a",
      workflow_id: "workflow-123",
      canvas_id: "page-a:workflow-123:canvas-root",
      command: "apply_canvas_patch",
      arguments: {
        base_revision: revision,
        operations: [{
          op: "add_node",
          temp_ref: "summary",
          class_type: "OpenBioSummary",
          pos: [200, 300],
        }],
      },
    },
  });

  const reply = fixture.requests.at(-1).body;
  assert.equal(reply.ok, true);
  assert.equal(fixture.graph.getNodeById(reply.result.id_map.summary).type, "OpenBioSummary");
});

test("concurrent canvas commands remain separate native transactions", async () => {
  const fixture = createWebFixture();
  await fixture.extension.setup();
  fixture.requests.length = 0;
  fixture.calls.length = 0;
  const revision = createLiveCanvas(fixture.app, fixture.LiteGraph, { pageId: "page-a" })
    .inspectCanvas().revision;
  const commandListener = fixture.customListeners.get(COMMAND_EVENT);
  const command = (requestId, pos) => commandListener({
    detail: {
      request_id: requestId,
      page_id: "page-a",
      workflow_id: "workflow-123",
      canvas_id: "page-a:workflow-123:canvas-root",
      command: "apply_canvas_patch",
      arguments: {
        base_revision: revision,
        operations: [{ op: "move_node", node_id: "7", pos }],
      },
    },
  });

  await Promise.all([
    command("request-first", [40, 80]),
    command("request-second", [100, 120]),
  ]);

  const replies = fixture.requests.filter(({ path }) => path === REPLY_PATH).map(({ body }) => body);
  assert.equal(replies.length, 2);
  assert.equal(replies.every(({ ok }) => ok), true);
  assert.notEqual(replies[0].result.revision, replies[1].result.revision);
  assert.deepEqual(
    fixture.calls.filter((call) => typeof call === "string" && call.includes("Change")),
    [
      "canvas.emitBeforeChange",
      "graph.beforeChange",
      "graph.afterChange",
      "canvas.emitAfterChange",
      "canvas.emitBeforeChange",
      "graph.beforeChange",
      "graph.afterChange",
      "canvas.emitAfterChange",
    ],
  );
});
