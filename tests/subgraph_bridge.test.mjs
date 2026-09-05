import assert from "node:assert/strict";
import test from "node:test";

import { createLiveCanvas } from "../web/canvas_bridge.mjs";
import { createSubgraphFixture } from "./helpers/subgraph_fixture.mjs";

function live(fixture) {
  return createLiveCanvas(fixture.app, fixture.LiteGraph, { pageId: "page-a" });
}

function patch(fixture, operations, inspection = live(fixture).inspectCanvas()) {
  return live(fixture).applyCanvasPatch({
    canvas_id: inspection.canvas_id,
    base_revision: inspection.revision,
    operations,
  });
}

function present(fixture, graph_id, refs = []) {
  return live(fixture).presentCanvas({
    canvas_id: live(fixture).identity.canvas_id,
    graph_id, refs, selection: "replace", fit_view: false,
  });
}

test("inspect and present follow a subgraph into its boundary links and back without an edit transaction", async () => {
  const fixture = createSubgraphFixture();
  const { root, subgraph, inner, host, canvas, calls } = fixture;
  subgraph.inputs[0].connect(inner.inputs[0], inner);
  subgraph.outputs[0].connect(inner.outputs[0], inner);
  const before = root.serialize();
  const inspection = live(fixture).inspectCanvas();
  assert.equal(inspection.root_graph_id, root.id);
  assert.equal(inspection.nodes.find(({ id }) => id === String(host.id)).subgraph_id, subgraph.id);
  assert.equal(live(fixture).inspectCanvas({ refs: [{ kind: "node", id: String(host.id) }] })
    .items[0].subgraph_id, subgraph.id);

  await present(fixture, subgraph.id, [{ kind: "node", id: String(inner.id) }]);
  const inside = live(fixture).inspectCanvas();
  assert.equal(inside.root_graph_id, root.id);
  assert.equal(inside.graph_id, subgraph.id);
  assert.equal(inside.revision, inspection.revision);
  assert.deepEqual(inside.subgraph, {
    name: "Processing",
    inputs: { node_id: "-10", slots: [{ name: "entry", type: "NUMBER" }] },
    outputs: { node_id: "-20", slots: [{ name: "exit", type: "NUMBER" }] },
  });
  assert.deepEqual(inside.links, [
    { id: "1", from: { node: "-10", output: "entry" }, to: { node: String(inner.id), input: "in" }, type: "NUMBER" },
    { id: "2", from: { node: String(inner.id), output: "out" }, to: { node: "-20", input: "exit" }, type: "NUMBER" },
  ]);
  assert.deepEqual(inside.nodes.map(({ id }) => id), [String(inner.id)]);
  await present(fixture, root.id);
  assert.equal(canvas.graph, root);
  assert.equal(canvas.subgraph, undefined);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "canvas.openSubgraph" && call[2] === host.id));
  assert.equal(calls.some((call) => typeof call === "string" && call.includes("Change")), false);
  assert.deepEqual(root.serialize(), before);
});

test("present validates destination refs before navigating", async () => {
  const fixture = createSubgraphFixture();
  await assert.rejects(present(fixture, fixture.subgraph.id, [{ kind: "node", id: "missing" }]), { code: "node_not_found" });
  await assert.rejects(present(fixture, "missing-graph"), { code: "graph_not_found" });
  assert.equal(fixture.canvas.graph, fixture.root);
  assert.deepEqual(fixture.calls, []);
});

test("root revisions reject stale edits after a hidden definition or its boundary changes", async () => {
  const fixture = createSubgraphFixture();
  const beforeDefinition = live(fixture).inspectCanvas();
  fixture.inner.widgets[0].value = "changed in another view";
  await assert.rejects(patch(fixture, [
    { op: "move_node", node_id: String(fixture.host.id), pos: [1, 2] },
  ], beforeDefinition), { code: "stale_revision" });

  await present(fixture, fixture.subgraph.id);
  const beforeBoundary = live(fixture).inspectCanvas();
  fixture.subgraph.renameInput(fixture.subgraph.inputs[0], "Dataset");
  await assert.rejects(patch(fixture, [
    { op: "move_node", node_id: String(fixture.inner.id), pos: [1, 2] },
  ], beforeBoundary), { code: "stale_revision" });
  assert.equal(fixture.subgraph.inputs[0].name, "entry");
  assert.equal(live(fixture).inspectCanvas().subgraph.inputs.slots[0].label, "Dataset");
});

test("boundary ports can be added, connected, relabelled, disconnected and removed in native order", async () => {
  const fixture = createSubgraphFixture();
  const { subgraph, inner, host, calls } = fixture;
  await present(fixture, subgraph.id);
  const nodeId = String(inner.id);
  await patch(fixture, [
    { op: "add_subgraph_port", direction: "input", name: "data", type: "NUMBER" },
    { op: "add_subgraph_port", direction: "output", name: "result", type: "NUMBER" },
    { op: "connect", source: "-10", output_name: "data", target: nodeId, input_name: "in" },
    { op: "connect", source: nodeId, output_name: "out", target: "-20", input_name: "result" },
    { op: "rename_subgraph_port", direction: "input", name: "data", label: "Dataset" },
    { op: "rename_subgraph_port", direction: "output", name: "result", label: "Summary" },
  ]);
  assert.deepEqual(live(fixture).inspectCanvas().subgraph.inputs.slots[1], {
    name: "data", type: "NUMBER", label: "Dataset",
  });
  assert.equal(host.inputs[1].label, "Dataset");
  assert.equal(host.outputs[1].label, "Summary");
  assert.equal(live(fixture).inspectCanvas().links.length, 2);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "subgraph.Input.connect"));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "subgraph.Output.connect"));

  await patch(fixture, [
    { op: "disconnect", target: nodeId, input_name: "in" },
    { op: "disconnect", target: "-20", input_name: "result" },
  ]);
  assert.deepEqual(live(fixture).inspectCanvas().links, []);
  await patch(fixture, [
    { op: "connect", source: "-10", output_name: "data", target: nodeId, input_name: "in" },
    { op: "connect", source: nodeId, output_name: "out", target: "-20", input_name: "result" },
    { op: "remove_subgraph_port", direction: "input", name: "data" },
    { op: "remove_subgraph_port", direction: "output", name: "result" },
  ]);
  assert.deepEqual(live(fixture).inspectCanvas().links, []);
  assert.deepEqual(host.inputs.map(({ name }) => name), ["entry"]);
  assert.deepEqual(host.outputs.map(({ name }) => name), ["exit"]);
});

test("boundary IDs remain link endpoints rather than editable nodes", async () => {
  const fixture = createSubgraphFixture();
  await present(fixture, fixture.subgraph.id);
  for (const operation of [
    { op: "move_node", node_id: "-10", pos: [10, 20] },
    { op: "remove_node", node_id: "-20" },
  ]) {
    await assert.rejects(patch(fixture, [operation]), { code: "node_not_found" });
  }
  await assert.rejects(patch(fixture, [
    { op: "connect", source: "-10", output_name: "entry", target: "-20", input_name: "exit" },
  ]), { code: "connection_rejected" });
});

test("failed subgraph edits restore the root definition, parent interface and visible graph", async () => {
  const fixture = createSubgraphFixture();
  const { root, subgraph, inner, host, canvas } = fixture;
  await present(fixture, subgraph.id);
  inner.widgets[0].callback = () => { throw new Error("injected widget failure"); };
  const before = root.serialize();
  await assert.rejects(patch(fixture, [
    { op: "add_subgraph_port", direction: "input", name: "unwanted", type: "NUMBER" },
    { op: "rename_subgraph_port", direction: "output", name: "exit", label: "Unwanted label" },
    { op: "set_input", node_id: String(inner.id), input_name: "value", value: "fails" },
  ]), /injected widget failure/);
  assert.deepEqual(root.serialize(), before);
  assert.deepEqual(root.getNodeById(host.id).inputs.map(({ name }) => name), ["entry"]);
  assert.equal(root.getNodeById(host.id).outputs[0].label, undefined);
  assert.equal(canvas.graph, root.subgraphs.get(subgraph.id));
  assert.notEqual(canvas.graph, subgraph);
  assert.equal(canvas.subgraph, canvas.graph);
  assert.equal(fixture.calls.filter((call) => call === "root.configure").length, 1);
});

test("conversion delegates a prepared node set to native APIs and unpack reports the new native items", async () => {
  const fixture = createSubgraphFixture();
  const { root, existing, host, subgraph, TestNode, TestGroup } = fixture;
  root.remove(host);
  let convertedNodes;
  root.convertToSubgraph = (nodes) => {
    convertedNodes = nodes;
    assert.equal([...nodes][1].widgets[0].value, "configured");
    assert.equal(root.links.length, 1);
    for (const node of nodes) root.remove(node);
    root.add(host);
    return { subgraph, node: host };
  };
  const converted = await patch(fixture, [
    { op: "add_node", temp_ref: "summary", class_type: "OpenBioSummary" },
    { op: "set_input", node_id: "summary", input_name: "value", value: "configured" },
    { op: "connect", source: String(existing.id), output_name: "out", target: "summary", input_name: "in" },
    { op: "convert_to_subgraph", node_ids: [String(existing.id), "summary"], temp_ref: "package", title: "Analysis" },
  ]);
  assert.ok(convertedNodes instanceof Set);
  assert.equal(convertedNodes.size, 2);
  assert.equal(converted.id_map.package, String(host.id));
  assert.equal(host.title, "Analysis");
  assert.equal(subgraph.name, "Analysis");
  assert.equal(live(fixture).inspectCanvas().nodes[0].subgraph_id, subgraph.id);

  const unpackedNode = new TestNode("OpenBioSummary");
  const unpackedGroup = new TestGroup("Native group");
  root.unpackSubgraph = (node) => {
    assert.equal(node, host);
    root.remove(node);
    root.add(unpackedNode);
    root.add(unpackedGroup);
  };
  const unpacked = await patch(fixture, [{ op: "unpack_subgraph", node_id: String(host.id) }]);
  assert.equal(root.getNodeById(host.id), null);
  assert.ok(unpacked.changed_node_ids.includes(String(unpackedNode.id)));
  assert.ok(unpacked.changed_group_ids.includes(String(unpackedGroup.id)));
});

test("structural changes must end the patch before any transaction starts", async () => {
  const fixture = createSubgraphFixture();
  for (const operation of [
    { op: "convert_to_subgraph", node_ids: [String(fixture.existing.id)], temp_ref: "package" },
    { op: "unpack_subgraph", node_id: String(fixture.host.id) },
  ]) {
    await assert.rejects(patch(fixture, [
      operation,
      { op: "move_node", node_id: String(fixture.existing.id), pos: [0, 0] },
    ]), { code: "invalid_patch" });
  }
  assert.deepEqual(fixture.calls, []);
});

test("conversion rechecks removal after widget callbacks and rolls back before calling native conversion", async () => {
  const fixture = createSubgraphFixture();
  const { root, existing } = fixture;
  let conversionCalled = false;
  root.convertToSubgraph = () => { conversionCalled = true; };
  existing.widgets[0].callback = () => { existing.ignore_remove = true; };
  const before = root.serialize();
  await assert.rejects(patch(fixture, [
    { op: "set_input", node_id: String(existing.id), input_name: "value", value: "lock" },
    { op: "convert_to_subgraph", node_ids: [String(existing.id)], temp_ref: "package" },
  ]), { code: "removal_rejected" });
  assert.equal(conversionCalled, false);
  assert.deepEqual(root.serialize(), before);
  assert.equal(root.getNodeById(existing.id).ignore_remove, undefined);
});
