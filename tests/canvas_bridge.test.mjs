import assert from "node:assert/strict";
import test from "node:test";

import { createLiveCanvas, readLiveCanvasIdentity } from "../web/canvas_bridge.mjs";
import { createCanvasFixture } from "./helpers/canvas_fixture.mjs";

test("inspect_canvas returns a compact live workflow snapshot using native string IDs", () => {
  const { app, existing, graph, LiteGraph } = createCanvasFixture();
  app.canvas.selected_nodes = { ignored: existing };
  existing.title = "Load data";
  existing.properties.large_internal_value = "not part of the compact snapshot";
  existing.widgets[0].value = "sample.h5ad";
  const downstream = LiteGraph.createNode("OpenBioSummary");
  downstream.pos = [320, 80];
  graph.add(downstream);
  existing.connect("out", downstream, "in");

  const result = createLiveCanvas(app, LiteGraph, { pageId: "page-a" }).inspectCanvas();

  assert.equal(result.page_id, "page-a");
  assert.equal(result.workflow_id, "workflow-123");
  assert.equal(result.workflow_path, "workflows/openbio.json");
  assert.equal(result.canvas_id, "page-a:workflow-123:canvas-root");
  assert.match(result.revision, /^v1-[0-9a-f]{8}$/);
  assert.deepEqual(result.nodes, [
    {
      id: "7",
      type: "OpenBioLoad",
      title: "Load data",
      pos: [40, 80],
      size: [180, 80],
    },
    {
      id: String(downstream.id),
      type: "OpenBioSummary",
      pos: [320, 80],
      size: [180, 80],
    },
  ]);
  assert.deepEqual(result.links, [
    {
      id: "1",
      from: { node: "7", output: "out" },
      to: { node: String(downstream.id), input: "in" },
      type: "*",
    },
  ]);
  assert.deepEqual(result.selection, [{ kind: "node", id: "7" }]);
  assert.deepEqual(result.viewport, {
    scale: 1.25,
    offset: [12, 24],
    visible_area: [10, 20, 900, 700],
  });
});

test("inspect_canvas keeps native group refs compact and identifies the selected group", () => {
  const { app, canvas, graph, LiteGraph, TestGroup } = createCanvasFixture();
  const group = new TestGroup("QC");
  group.color = "#2f806d";
  group._bounding = [20, 30, 600, 320];
  group.flags.pinned = true;
  graph.add(group);
  canvas.selectedItems = new Set([group]);

  const result = createLiveCanvas(app, LiteGraph, { pageId: "page-a" }).inspectCanvas();

  assert.deepEqual(result.groups, [{
    id: String(group.id),
    title: "QC",
    bounding: [20, 30, 600, 320],
  }]);
  assert.deepEqual(result.selection, [{ kind: "group", id: String(group.id) }]);
});

test("inspect_canvas resolves a native node ref to edit-relevant details only", () => {
  const { app, existing, graph, LiteGraph, TestGroup } = createCanvasFixture();
  existing.title = "Load data";
  existing.widgets[0].value = "sample.h5ad";
  existing.inputs[0].type = "OPENBIO_DATA";
  existing.outputs[0].type = "OPENBIO_DATA";
  const downstream = LiteGraph.createNode("OpenBioSummary");
  downstream.pos = [320, 80];
  graph.add(downstream);
  existing.connect("out", downstream, "in");
  graph.links[0][5] = "OPENBIO_DATA";
  const group = new TestGroup("Inputs");
  group._bounding = [20, 30, 240, 180];
  graph.add(group);

  const result = createLiveCanvas(app, LiteGraph, { pageId: "page-a" }).inspectCanvas({
    refs: [{ kind: "node", id: "7" }],
  });

  assert.equal(result.canvas_id, "page-a:workflow-123:canvas-root");
  assert.match(result.revision, /^v1-[0-9a-f]{8}$/);
  assert.equal(Object.hasOwn(result, "nodes"), false);
  assert.equal(Object.hasOwn(result, "groups"), false);
  assert.deepEqual(result.items, [{
    kind: "node",
    id: "7",
    type: "OpenBioLoad",
    title: "Load data",
    pos: [40, 80],
    size: [180, 80],
    widgets: { value: "sample.h5ad" },
    inputs: [{ name: "in", type: "OPENBIO_DATA" }],
    outputs: [{ name: "out", type: "OPENBIO_DATA" }],
    groups: [{ kind: "group", id: String(group.id) }],
  }]);
  assert.deepEqual(result.links, [{
    id: "1",
    from: { node: "7", output: "out" },
    to: { node: String(downstream.id), input: "in" },
    type: "OPENBIO_DATA",
  }]);
});

test("inspect_canvas resolves a native group ref without mutating derived membership", () => {
  const { app, graph, LiteGraph, TestGroup } = createCanvasFixture();
  const outside = LiteGraph.createNode("OpenBioOutside");
  outside.pos = [600, 500];
  graph.add(outside);
  const group = new TestGroup("Inputs");
  group.color = "#2f806d";
  group.flags.pinned = true;
  group._bounding = [20, 30, 240, 180];
  graph.add(group);

  const result = createLiveCanvas(app, LiteGraph, { pageId: "page-a" }).inspectCanvas({
    refs: [{ kind: "group", id: String(group.id) }],
  });

  assert.deepEqual(result.items, [{
    kind: "group",
    id: String(group.id),
    title: "Inputs",
    bounding: [20, 30, 240, 180],
    color: "#2f806d",
    flags: { pinned: true },
    contained_nodes: [{ kind: "node", id: "7" }],
  }]);
  assert.deepEqual(result.links, []);
  assert.deepEqual(graph.nodes.map(({ id }) => String(id)), ["7", String(outside.id)]);
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

test("present_canvas replaces, adds, clears, and fits the live selection without changing the workflow", async (t) => {
  const { app, canvas, graph, LiteGraph, calls, TestGroup } = createCanvasFixture();
  const childGroup = new TestGroup("Child");
  childGroup._bounding = [40, 70, 220, 140];
  graph.add(childGroup);
  const group = new TestGroup("Presented");
  group._bounding = [20, 30, 400, 260];
  graph.add(group);
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  const snapshot = graph.serialize();
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });
  const frameCallbacks = [];
  globalThis.requestAnimationFrame = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  canvas.fitViewToSelectionAnimated = ({ duration }) => {
    calls.push("canvas.fitViewToSelectionAnimated");
    const startedAt = globalThis.performance.now();
    const animate = (timestamp) => {
      if (timestamp - startedAt < duration) {
        globalThis.requestAnimationFrame(animate);
        return;
      }
      canvas.ds.state.scale = 0.75;
      canvas.ds.state.offset = [100, 60];
      globalThis.requestAnimationFrame(() => {
        canvas.ds.visible_area = new Float64Array([20, 30, 400, 260]);
      });
    };
    globalThis.requestAnimationFrame(animate);
  };
  canvas.ds.computeVisibleArea = () => { calls.push("canvas.ds.computeVisibleArea"); };

  const frameStart = globalThis.performance.now();
  const replacedPromise = liveCanvas.presentCanvas({
    canvas_id: inspected.canvas_id,
    refs: [{ kind: "group", id: group.id }],
    selection: "replace",
    fit_view: true,
  });
  for (const elapsed of [0, 200, 400, 600]) {
    const callbacks = frameCallbacks.splice(0);
    for (const callback of callbacks) callback(frameStart + elapsed);
    await Promise.resolve();
  }
  const replaced = await replacedPromise;
  const added = await liveCanvas.presentCanvas({
    canvas_id: inspected.canvas_id,
    refs: [{ kind: "node", id: "7" }],
    selection: "add",
    fit_view: false,
  });
  const cleared = await liveCanvas.presentCanvas({
    canvas_id: inspected.canvas_id,
    refs: [],
    selection: "replace",
    fit_view: false,
  });

  assert.deepEqual(replaced, {
    canvas_id: inspected.canvas_id,
    selection: [{ kind: "group", id: String(group.id) }],
    viewport: {
      scale: 0.75,
      offset: [100, 60],
      visible_area: [20, 30, 400, 260],
    },
  });
  assert.deepEqual(added.selection, [
    { kind: "group", id: String(group.id) },
    { kind: "node", id: "7" },
  ]);
  assert.deepEqual(cleared.selection, []);
  assert.deepEqual(graph.serialize(), snapshot);
  assert.equal(liveCanvas.inspectCanvas().revision, inspected.revision);
  assert.equal(calls.includes("canvas.fitViewToSelectionAnimated"), true);
  assert.deepEqual(
    calls.filter((call) => typeof call === "string" && call.includes("Change")),
    [],
  );
  assert.equal(calls.includes("graph.setDirtyCanvas"), false);
});

test("present_canvas resolves every ref before replacing the current selection", async () => {
  const { app, canvas, existing, graph, LiteGraph, calls, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Valid");
  graph.add(group);
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  calls.length = 0;

  await assert.rejects(
    liveCanvas.presentCanvas({
      canvas_id: inspected.canvas_id,
      refs: [
        { kind: "group", id: group.id },
        { kind: "node", id: "missing" },
      ],
      selection: "replace",
      fit_view: true,
    }),
    (error) => error.code === "node_not_found",
  );

  assert.deepEqual([...canvas.selectedItems], [existing]);
  assert.deepEqual(calls, []);
});

test("present_canvas completes fitting when animation frames are unavailable", async (t) => {
  const { app, canvas, LiteGraph, calls } = createCanvasFixture();
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });
  delete globalThis.requestAnimationFrame;
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const presented = await liveCanvas.presentCanvas({
    canvas_id: inspected.canvas_id,
    refs: [{ kind: "node", id: "7" }],
    selection: "replace",
    fit_view: true,
  });

  assert.deepEqual(presented.viewport.offset, [-30, -70]);
  assert.equal(presented.viewport.scale, 0.75);
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "canvas.ds.fitToBounds"),
    true,
  );
  assert.equal(calls.includes("canvas.ds.computeVisibleArea"), true);
  assert.equal(canvas.selectedItems.size, 1);
});

test("present_canvas rejects a canvas switch while waiting for the fit animation", async (t) => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });
  const frameCallbacks = [];
  globalThis.requestAnimationFrame = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  const presentation = liveCanvas.presentCanvas({
    canvas_id: inspected.canvas_id,
    refs: [{ kind: "node", id: "7" }],
    selection: "replace",
    fit_view: true,
  });
  app.canvas = { graph };

  const frameStart = globalThis.performance.now();
  for (const elapsed of [0, 400, 600]) {
    const callbacks = frameCallbacks.splice(0);
    for (const callback of callbacks) callback(frameStart + elapsed);
    await Promise.resolve();
  }

  await assert.rejects(presentation, (error) => error.code === "canvas_changed");
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

test("apply_canvas_patch adds and updates a native group in one transaction", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      {
        op: "add_group",
        temp_ref: "analysis",
        title: "Initial",
        bounding: [10, 20, 240, 160],
        color: "#112233",
        pinned: true,
      },
      {
        op: "update_group",
        group_id: "analysis",
        title: "Analysis",
        bounding: [30, 40, 360, 220],
        color: null,
        pinned: false,
      },
    ],
  });

  const group = graph.groups.find(({ id }) => String(id) === applied.group_id_map.analysis);
  assert.equal(group.title, "Analysis");
  assert.deepEqual(group._bounding, [30, 40, 360, 220]);
  assert.equal(group.color, undefined);
  assert.deepEqual(group.flags, {});
  assert.deepEqual(applied.changed_group_ids, [String(group.id)]);
  assert.deepEqual(applied.changed_node_ids, []);
  assert.notEqual(applied.revision, inspected.revision);
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

test("fit_group_to_nodes fits moved and newly added nodes without moving them", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      { op: "move_node", node_id: "7", pos: [100, 100] },
      { op: "add_node", temp_ref: "summary", class_type: "OpenBioSummary", pos: [300, 200] },
      { op: "add_group", temp_ref: "fitted", title: "Fitted" },
      {
        op: "fit_group_to_nodes",
        group_id: "fitted",
        node_ids: ["7", "summary"],
        padding: 20,
      },
    ],
  });

  const group = graph.groups.find(({ id }) => String(id) === applied.group_id_map.fitted);
  assert.deepEqual(graph.getNodeById(7).pos, [100, 100]);
  assert.deepEqual(graph.getNodeById(applied.id_map.summary).pos, [300, 200]);
  assert.deepEqual(group._bounding, [80, 50, 420, 250]);
});

test("move_group moves a fitted group and its contents in the same native transaction", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      { op: "add_node", temp_ref: "summary", class_type: "OpenBioSummary", pos: [300, 200] },
      { op: "add_group", temp_ref: "analysis", title: "Analysis" },
      {
        op: "fit_group_to_nodes",
        group_id: "analysis",
        node_ids: ["7", "summary"],
        padding: 20,
      },
      { op: "move_group", group_id: "analysis", delta: [50, -20] },
    ],
  });

  const group = graph.groups.find(({ id }) => String(id) === applied.group_id_map.analysis);
  assert.deepEqual(group._bounding, [70, 10, 480, 270]);
  assert.deepEqual(graph.getNodeById(7).pos, [90, 60]);
  assert.deepEqual(graph.getNodeById(applied.id_map.summary).pos, [350, 180]);
  assert.deepEqual(applied.changed_node_ids, ["7", applied.id_map.summary].sort());
  assert.deepEqual(applied.changed_group_ids, [String(group.id)]);
  assert.notEqual(applied.revision, inspected.revision);
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
  const finalRecomputeIndex = calls.findLastIndex(
    (call) => Array.isArray(call) && call[0] === "group.recomputeInsideNodes",
  );
  const firstMoveIndex = calls.findIndex(
    (call) => Array.isArray(call) && ["group.move", "node.move"].includes(call[0]),
  );
  assert.ok(finalRecomputeIndex < firstMoveIndex);
});

test("move_group rejects a pinned group during preflight without changing the graph", async () => {
  const { app, graph, LiteGraph, calls, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Pinned");
  group._bounding = [0, 0, 400, 300];
  group.pin(true);
  graph.add(group);
  const snapshot = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "move_node", node_id: "7", pos: [500, 500] },
        { op: "move_group", group_id: group.id, delta: [50, 20] },
      ],
    }),
    (error) => error.code === "movement_rejected" && error.details.group_id === String(group.id),
  );

  assert.deepEqual(graph.serialize(), snapshot);
  assert.deepEqual(calls, []);
});

test("move_group follows earlier pin changes in the same ordered patch", async () => {
  const { app, graph, LiteGraph, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Pinned");
  group._bounding = [0, 0, 400, 300];
  group.pin(true);
  graph.add(group);
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [
      { op: "update_group", group_id: group.id, pinned: false },
      { op: "move_group", group_id: group.id, delta: [25, 15] },
    ],
  });

  assert.deepEqual(group._bounding, [25, 15, 400, 300]);
  assert.deepEqual(graph.getNodeById(7).pos, [65, 95]);
  assert.deepEqual(applied.changed_group_ids, [String(group.id)]);
  assert.deepEqual(applied.changed_node_ids, ["7"]);
});

test("move_group uses the native Vue movement path and moves nested contents once", async () => {
  const { app, graph, LiteGraph, calls, TestGroup } = createCanvasFixture();
  const inner = new TestGroup("Inner");
  inner._bounding = [20, 40, 260, 180];
  graph.add(inner);
  const outer = new TestGroup("Outer");
  outer._bounding = [0, 0, 400, 300];
  graph.add(outer);
  LiteGraph.vueNodesMode = true;
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "move_group", group_id: outer.id, delta: [30, 10] }],
  });

  assert.deepEqual(outer._bounding, [30, 10, 400, 300]);
  assert.deepEqual(inner._bounding, [50, 50, 260, 180]);
  assert.deepEqual(graph.getNodeById(7).pos, [70, 90]);
  assert.deepEqual(applied.changed_group_ids, [String(inner.id), String(outer.id)].sort());
  assert.deepEqual(applied.changed_node_ids, ["7"]);
  assert.equal(
    calls.filter((call) => Array.isArray(call) && call[0] === "canvas.moveChildNodesInGroupVueMode").length,
    1,
  );
  assert.equal(
    calls.filter((call) => Array.isArray(call) && call[0] === "node.setPos").length,
    1,
  );
});

test("remove_group removes only the group and keeps its nodes", async () => {
  const { app, graph, LiteGraph, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Temporary");
  group._bounding = [0, 0, 400, 300];
  graph.add(group);
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const applied = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "remove_group", group_id: group.id }],
  });

  assert.deepEqual(graph.groups, []);
  assert.equal(graph.getNodeById(7)?.type, "OpenBioLoad");
  assert.deepEqual(applied.changed_group_ids, [String(group.id)]);
});

test("invalid group references are rejected before the live graph changes", async () => {
  for (const operation of [
    { op: "update_group", group_id: "missing", title: "Nope" },
    { op: "move_group", group_id: "missing", delta: [10, 20] },
    {
      op: "fit_group_to_nodes",
      group_id: "missing",
      node_ids: ["7"],
    },
  ]) {
    const { app, graph, LiteGraph, calls } = createCanvasFixture();
    const before = graph.serialize();
    const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
    const inspected = liveCanvas.inspectCanvas();

    await assert.rejects(
      liveCanvas.applyCanvasPatch({
        canvas_id: inspected.canvas_id,
        base_revision: inspected.revision,
        operations: [
          { op: "move_node", node_id: "7", pos: [500, 500] },
          operation,
        ],
      }),
      (error) => error.code === "group_not_found",
    );

    assert.deepEqual(graph.serialize(), before);
    assert.deepEqual(calls, []);
  }
});

test("fit_group_to_nodes rejects a missing node before the live graph changes", async () => {
  const { app, graph, LiteGraph, calls, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Existing");
  graph.add(group);
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "move_node", node_id: "7", pos: [500, 500] },
        { op: "fit_group_to_nodes", group_id: group.id, node_ids: ["missing"] },
      ],
    }),
    (error) => error.code === "node_not_found",
  );

  assert.deepEqual(graph.serialize(), before);
  assert.deepEqual(calls, []);
});

test("a failed patch restores group changes from the prior snapshot", async () => {
  const { app, graph, existing, LiteGraph, TestGroup } = createCanvasFixture();
  const group = new TestGroup("Original");
  group._bounding = [20, 30, 300, 200];
  graph.add(group);
  const before = graph.serialize();
  existing.widgets[0].callback = () => { throw new Error("widget failed"); };
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [
        { op: "update_group", group_id: group.id, title: "Changed" },
        { op: "set_input", node_id: "7", input_name: "value", value: "temporary" },
      ],
    }),
    /widget failed/,
  );

  assert.deepEqual(graph.serialize(), before);
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

test("an empty patch is rejected before the native transaction starts", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [],
    }),
    (error) => {
      assert.equal(error.code, "invalid_patch");
      assert.equal(error.message, "A canvas patch must contain at least one operation");
      return true;
    },
  );

  assert.deepEqual(graph.serialize(), before);
  assert.deepEqual(calls, []);
});

test("a patch requires an operations array before the native transaction starts", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  const patches = [
    null,
    { canvas_id: inspected.canvas_id, base_revision: inspected.revision },
    { canvas_id: inspected.canvas_id, base_revision: inspected.revision, operations: null },
    { canvas_id: inspected.canvas_id, base_revision: inspected.revision, operations: {} },
  ];

  for (const patch of patches) {
    await assert.rejects(
      liveCanvas.applyCanvasPatch(patch),
      (error) => {
        assert.equal(error.code, "invalid_patch");
        assert.equal(error.message, "Canvas patch operations must be an array");
        return true;
      },
    );
  }

  assert.deepEqual(graph.serialize(), before);
  assert.deepEqual(calls, []);
});

test("every patch operation requires a non-empty string discriminant", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();
  const invalidOperations = [null, [], {}, { op: null }, { op: "" }];

  for (const operation of invalidOperations) {
    await assert.rejects(
      liveCanvas.applyCanvasPatch({
        canvas_id: inspected.canvas_id,
        base_revision: inspected.revision,
        operations: [operation],
      }),
      (error) => {
        assert.equal(error.code, "invalid_patch");
        assert.equal(error.message, "Each canvas patch operation must have a non-empty string op");
        assert.deepEqual(error.details, { operation_index: 0 });
        return true;
      },
    );
  }

  assert.deepEqual(graph.serialize(), before);
  assert.deepEqual(calls, []);
});

test("an unknown patch operation is rejected before the native transaction starts", async () => {
  const { app, graph, LiteGraph, calls } = createCanvasFixture();
  const before = graph.serialize();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  await assert.rejects(
    liveCanvas.applyCanvasPatch({
      canvas_id: inspected.canvas_id,
      base_revision: inspected.revision,
      operations: [{ op: "future_operation" }],
    }),
    (error) => {
      assert.equal(error.code, "unsupported_operation");
      assert.deepEqual(error.details, { operation: "future_operation" });
      return true;
    },
  );

  assert.deepEqual(graph.serialize(), before);
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

test("an unpositioned added group starts at the visible canvas center", async () => {
  const { app, graph, LiteGraph } = createCanvasFixture();
  const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId: "page-a" });
  const inspected = liveCanvas.inspectCanvas();

  const result = await liveCanvas.applyCanvasPatch({
    canvas_id: inspected.canvas_id,
    base_revision: inspected.revision,
    operations: [{ op: "add_group", temp_ref: "centered", title: "Centered" }],
  });

  const group = graph.groups.find(({ id }) => String(id) === result.group_id_map.centered);
  assert.deepEqual(group._bounding, [390, 330, 140, 80]);
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
