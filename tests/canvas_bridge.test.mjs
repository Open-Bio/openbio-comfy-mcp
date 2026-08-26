import assert from "node:assert/strict";
import test from "node:test";

import { createLiveCanvas, readLiveCanvasIdentity } from "../web/canvas_bridge.mjs";
import { createCanvasFixture } from "./helpers/canvas_fixture.mjs";

test("inspect_canvas describes the exact visible workflow and canonical selection", () => {
  const { app, existing, LiteGraph } = createCanvasFixture();
  app.canvas.selected_nodes = { ignored: existing };

  const result = createLiveCanvas(app, LiteGraph, { pageId: "page-a" }).inspectCanvas();

  assert.equal(result.page_id, "page-a");
  assert.equal(result.workflow_id, "workflow-123");
  assert.equal(result.workflow_path, "workflows/openbio.json");
  assert.equal(result.canvas_id, "page-a:workflow-123:canvas-root");
  assert.match(result.revision, /^v1-[0-9a-f]{8}$/);
  assert.deepEqual(result.nodes.map(({ id, type, pos }) => ({ id, type, pos })), [
    { id: 7, type: "OpenBioLoad", pos: [40, 80] },
  ]);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.selection, [{ kind: "node", id: "7" }]);
  assert.deepEqual(result.viewport, {
    scale: 1.25,
    offset: [12, 24],
    visible_area: [10, 20, 900, 700],
  });
});

test("canvas identity distinguishes the root graph from an active subgraph", () => {
  const { app } = createCanvasFixture();
  const root = readLiveCanvasIdentity(app, "page-a");
  app.canvas.graph = { id: "subgraph-9" };
  const subgraph = readLiveCanvasIdentity(app, "page-a");

  assert.notEqual(root.canvas_id, subgraph.canvas_id);
  assert.equal(subgraph.canvas_id, "page-a:workflow-123:subgraph-9");
});

test("legacy reroute changes invalidate the canvas revision", () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  let reroutes = [{ id: 4, pos: [10, 20] }];
  const serialize = graph.serialize.bind(graph);
  graph.serialize = () => ({ ...serialize(), extra: { reroutes: structuredClone(reroutes) } });
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const before = liveCanvas.inspectCanvas().revision;
  reroutes = [{ id: 4, pos: [30, 40] }];

  assert.notEqual(liveCanvas.inspectCanvas().revision, before);
});

test("apply_canvas_patch edits the live graph in one native transaction", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      { op: "add_node", temp_ref: "summary", class_type: "OpenBioSummary", pos: [320, 80] },
      { op: "set_input", node_id: "summary", input_name: "value", value: { mode: "brief" } },
      { op: "connect", source: "7", output_name: "out", target: "summary", input_name: "in" },
      { op: "move_node", node_id: "7", pos: [60, 100] },
    ],
  });

  const added = graph.getNodeById(applied.id_map.summary);
  assert.equal(added.type, "OpenBioSummary");
  assert.deepEqual(added.pos, [320, 80]);
  assert.deepEqual(added.widgets[0].value, { mode: "brief" });
  assert.deepEqual(graph.getNodeById(7).pos, [60, 100]);
  assert.deepEqual(graph.links.map((link) => link.slice(1, 5)), [[7, 0, added.id, 0]]);
  assert.match(applied.revision, /^v1-[0-9a-f]{8}$/);
  assert.notEqual(applied.revision, inspected.revision);
  assert.deepEqual(applied.changed_node_ids, [String(added.id), "7"].sort());
  assert.equal(applied.undoable, true);
  assert.deepEqual(
    calls.filter((call) => typeof call === "string" && call.includes("Change")),
    [
      "canvas.emitBeforeChange",
      "graph.beforeChange",
      "graph.afterChange",
      "canvas.emitAfterChange",
    ],
  );
});

test("a stale revision is rejected before the native transaction starts", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  graph.getNodeById(7).pos = [999, 999];

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [0, 0] }],
    }),
    (error) => error.code === "stale_revision",
  );
  assert.deepEqual(calls, []);
});

test("a graph before-change failure closes the canvas transaction", async () => {
  const { app, canvas, graph, existing, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  let transactionDepth = 0;
  app.canvas.emitBeforeChange = () => {
    calls.push("canvas.emitBeforeChange");
    transactionDepth += 1;
  };
  app.canvas.emitAfterChange = () => {
    calls.push("canvas.emitAfterChange");
    transactionDepth -= 1;
  };
  graph.beforeChange = () => {
    calls.push("graph.beforeChange");
    throw new Error("graph before-change hook failed");
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [500, 500] }],
    }),
    /graph before-change hook failed/,
  );

  assert.equal(transactionDepth, 0);
  assert.equal(graph.getNodeById(7), existing);
  assert.equal(canvas.selectedItems.has(existing), true);
  assert.deepEqual(liveCanvas.inspectCanvas().selection, [{ kind: "node", id: "7" }]);
  assert.deepEqual(graph.serialize(), before);
});

test("an invalid patch performs no live write or widget callback", async () => {
  const { app, graph, existing, LiteGraph, calls, TestNode } = createCanvasFixture();
  const target = new TestNode("OpenBioTarget");
  target.id = 8;
  graph.add(target);
  existing.connect("out", target, "in");
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "disconnect", target: "8", input_name: "in" },
        { op: "set_input", node_id: "7", input_name: "value", value: "temporary" },
        { op: "remove_node", node_id: "7" },
        { op: "add_node", temp_ref: "missing", class_type: "Missing" },
      ],
    }),
    (error) => error.code === "node_type_not_found",
  );

  assert.deepEqual(graph.serialize(), before);
  assert.equal(graph.getNodeById(7), existing);
  assert.equal(app.canvas.selectedItems.has(existing), true);
  assert.deepEqual(calls, []);
});

test("an invalid disconnect is rejected before earlier operations reach the live graph", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "move_node", node_id: "7", pos: [500, 500] },
        { op: "disconnect", target: "7", input_name: "missing" },
      ],
    }),
    (error) => error.code === "input_not_found",
  );

  assert.deepEqual(graph.getNodeById(7).pos, [40, 80]);
  assert.deepEqual(calls, []);
});

test("a protected node removal is rejected before earlier operations reach the live graph", async () => {
  const { app, graph, existing, LiteGraph, calls } = createCanvasFixture();
  existing.ignore_remove = true;
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "move_node", node_id: "7", pos: [500, 500] },
        { op: "remove_node", node_id: "7" },
      ],
    }),
    (error) => error.code === "removal_rejected",
  );

  assert.deepEqual(graph.getNodeById(7).pos, [40, 80]);
  assert.deepEqual(calls, []);
});

test("canvas deletion protections reject a patch before it reaches the live graph", async () => {
  for (const property of ["block_delete", "removable"]) {
    const { app, graph, existing, LiteGraph, calls } = createCanvasFixture();
    existing[property] = property === "removable" ? false : true;
    const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
    const inspected = liveCanvas.inspectCanvas();

    await assert.rejects(
      liveCanvas.applyCanvasPatch({
        canvas_id: inspected.canvas_id,
        base_revision: inspected.revision,
        operations: [
          { op: "move_node", node_id: "7", pos: [500, 500] },
          { op: "remove_node", node_id: "7" },
        ],
      }),
      (error) => error.code === "removal_rejected",
    );

    assert.deepEqual(graph.getNodeById(7).pos, [40, 80]);
    assert.deepEqual(calls, []);
  }
});

test("a native transaction-closing failure restores the prior graph", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const before = graph.serialize();
  const tracker = app.extensionManager.workflow.activeWorkflow.changeTracker;
  tracker.changeCount = 0;
  tracker.capturedStates = [];
  tracker.beforeChange = () => {
    tracker.changeCount += 1;
  };
  tracker.afterChange = () => {
    tracker.changeCount -= 1;
    if (tracker.changeCount === 0) tracker.capturedStates.push(graph.serialize());
  };
  app.canvas.emitBeforeChange = () => tracker.beforeChange();
  app.canvas.emitAfterChange = () => {
    throw new Error("after-change hook failed");
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [500, 500] }],
    }),
    /after-change hook failed/,
  );

  assert.equal(tracker.changeCount, 0);
  assert.deepEqual(tracker.capturedStates, [before]);
  assert.deepEqual(graph.serialize(), before);
});

test("a graph after-change failure still closes the canvas transaction", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  let transactionDepth = 0;
  app.canvas.emitBeforeChange = () => {
    calls.push("canvas.emitBeforeChange");
    transactionDepth += 1;
  };
  app.canvas.emitAfterChange = () => {
    calls.push("canvas.emitAfterChange");
    transactionDepth -= 1;
  };
  graph.afterChange = () => {
    calls.push("graph.afterChange");
    throw new Error("graph after-change hook failed");
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [500, 500] }],
    }),
    /graph after-change hook failed/,
  );

  assert.equal(transactionDepth, 0);
  assert.deepEqual(graph.serialize(), before);
});

test("a final serialization failure restores the prior graph", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const serialize = graph.serialize.bind(graph);
  const before = serialize();
  let serializeCount = 0;
  let transactionDepth = 0;
  const capturedStates = [];
  graph.serialize = () => {
    serializeCount += 1;
    if (serializeCount === 3) throw new Error("serialize failed");
    return serialize();
  };
  app.canvas.emitBeforeChange = () => {
    transactionDepth += 1;
  };
  app.canvas.emitAfterChange = () => {
    transactionDepth -= 1;
    if (transactionDepth === 0) capturedStates.push(serialize());
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [500, 500] }],
    }),
    /serialize failed/,
  );

  assert.equal(transactionDepth, 0);
  assert.deepEqual(serialize(), before);
  assert.deepEqual(capturedStates, [before]);
});

test("unpositioned added nodes start at the visible canvas center", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const result = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      { op: "add_node", temp_ref: "first", class_type: "OpenBioFirst" },
      { op: "add_node", temp_ref: "second", class_type: "OpenBioSecond" },
    ],
  });

  assert.deepEqual(graph.getNodeById(result.id_map.first).pos, [370, 330]);
  assert.deepEqual(graph.getNodeById(result.id_map.second).pos, [410, 330]);
});

test("the native transaction closes before graph microtasks run", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  let transactionDepth = 0;
  let depthInMicrotask;
  app.canvas.emitBeforeChange = () => {
    transactionDepth += 1;
  };
  app.canvas.emitAfterChange = () => {
    transactionDepth -= 1;
  };
  graph.afterChange = () => {
    queueMicrotask(() => {
      depthInMicrotask = transactionDepth;
    });
  };

  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "move_node", node_id: "7", pos: [60, 100] }],
  });

  assert.equal(depthInMicrotask, 0);
  assert.equal(transactionDepth, 0);
});

test("the native transaction closes before the next macrotask", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  let transactionDepth = 0;
  let depthInTimer;
  app.canvas.emitBeforeChange = () => {
    transactionDepth += 1;
  };
  app.canvas.emitAfterChange = () => {
    transactionDepth -= 1;
  };
  graph.afterChange = () => {
    setTimeout(() => {
      depthInTimer = transactionDepth;
    }, 0);
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "move_node", node_id: "7", pos: [60, 100] }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(depthInTimer, 0);
  assert.equal(transactionDepth, 0);
});

test("a workflow switch during failure never configures the detached graph or closes its inactive tracker", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const originalWorkflow = app.extensionManager.workflow.activeWorkflow;
  let configureCalls = 0;
  const configure = graph.configure.bind(graph);
  graph.configure = (snapshot) => {
    configureCalls += 1;
    return configure(snapshot);
  };
  const replacementSnapshot = graph.serialize();
  replacementSnapshot.id = "replacement-graph";
  replacementSnapshot.nodes[0].pos = [900, 900];
  const tracker = () => ({
    changeCount: 0,
    beforeChange() { this.changeCount += 1; },
    afterChange() { this.changeCount -= 1; },
  });
  originalWorkflow.changeTracker = tracker();
  const replacementWorkflow = {
    path: "workflows/replacement.json",
    changeTracker: tracker(),
  };
  app.canvas.emitBeforeChange = () => {
    app.extensionManager.workflow.activeWorkflow.changeTracker.beforeChange();
  };
  app.canvas.emitAfterChange = () => {
    app.extensionManager.workflow.activeWorkflow.changeTracker.afterChange();
  };
  let replacementGraph;
  graph.afterChange = () => {
    replacementGraph = new graph.constructor(replacementSnapshot);
    app.canvas.graph = replacementGraph;
    app.extensionManager.workflow.activeWorkflow = replacementWorkflow;
    throw new Error("after-change switched workflows");
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "move_node", node_id: "7", pos: [60, 100] }],
    }),
    /after-change switched workflows/,
  );

  assert.equal(originalWorkflow.changeTracker.changeCount, 0);
  assert.equal(replacementWorkflow.changeTracker.changeCount, 0);
  assert.equal(configureCalls, 0);
  assert.deepEqual(graph.getNodeById(7).pos, [60, 100]);
  assert.deepEqual(replacementGraph.getNodeById(7).pos, [900, 900]);
});

test("switching from the root to its subgraph does not reconfigure the root", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const tracker = app.extensionManager.workflow.activeWorkflow.changeTracker;
  tracker.changeCount = 0;
  tracker.beforeChange = function () {
    this.changeCount += 1;
  };
  tracker.afterChange = function () {
    this.changeCount -= 1;
  };
  app.canvas.emitBeforeChange = () => tracker.beforeChange();
  app.canvas.emitAfterChange = () => tracker.afterChange();
  let configureCalls = 0;
  const configure = graph.configure.bind(graph);
  graph.configure = (snapshot) => {
    configureCalls += 1;
    return configure(snapshot);
  };
  const subgraph = {
    id: "subgraph-1",
    rootGraph: graph,
  };
  graph.afterChange = () => {
    app.canvas.graph = subgraph;
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "move_node", node_id: "7", pos: [60, 100] }],
  });

  assert.equal(applied.canvas_id, inspected.canvas_id);
  assert.equal(tracker.changeCount, 0);
  assert.equal(configureCalls, 0);
  assert.equal(app.canvas.graph, subgraph);
  assert.deepEqual(graph.getNodeById(7).pos, [60, 100]);
});
