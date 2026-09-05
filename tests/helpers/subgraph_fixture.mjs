import { createCanvasFixture } from "./canvas_fixture.mjs";

export function createSubgraphFixture() {
  const fixture = createCanvasFixture();
  const { graph: root, canvas, calls, TestNode } = fixture;
  const Graph = root.constructor;
  const serializeGraph = Graph.prototype.serialize;
  const configureGraph = Graph.prototype.configure;
  const slotData = ({ name, type, label }) => ({ name, type, ...(label === undefined ? {} : { label }) });
  const objectLink = ([id, origin_id, origin_slot, target_id, target_slot, type]) => (
    { id, origin_id, origin_slot, target_id, target_slot, type }
  );

  function bindHost(node, subgraph) {
    node.subgraph = subgraph;
    node.isSubgraphNode = () => true;
    node.inputs = subgraph.inputs.map((slot) => ({ ...slotData(slot), link: null }));
    node.outputs = subgraph.outputs.map((slot) => ({ ...slotData(slot), links: [] }));
    node.serialize = () => ({
      ...TestNode.prototype.serialize.call(node),
      subgraph_id: subgraph.id,
      inputs: structuredClone(node.inputs),
      outputs: structuredClone(node.outputs),
    });
  }

  function createSubgraph(id) {
    const subgraph = new Graph();
    subgraph.id = id;
    subgraph.name = "Processing";
    subgraph.rootGraph = root;
    subgraph.inputs = [];
    subgraph.outputs = [];
    // Native IO nodes are boundary endpoints, absent from nodes/getNodeById.
    subgraph.inputNode = { id: -10, graph: subgraph, outputs: subgraph.inputs };
    subgraph.outputNode = { id: -20, graph: subgraph, inputs: subgraph.outputs };
    const syncHosts = () => {
      for (const node of root.nodes) {
        if (node.subgraph === subgraph) bindHost(node, subgraph);
      }
    };
    for (const [direction, slots, ioNode] of [
      ["Input", subgraph.inputs, subgraph.inputNode],
      ["Output", subgraph.outputs, subgraph.outputNode],
    ]) {
      subgraph[`add${direction}`] = (name, type) => {
        calls.push([`subgraph.add${direction}`, name, type]);
        const slot = {
          name, type, links: [], link: null,
          connect(nodeSlot, node) {
            calls.push([`subgraph.${direction}.connect`, name, node.id, nodeSlot.name]);
            const link = direction === "Input"
              ? TestNode.prototype.connect.call(ioNode, slots.indexOf(slot), node, node.inputs.indexOf(nodeSlot))
              : node.connect(node.outputs.indexOf(nodeSlot), ioNode, slots.indexOf(slot));
            link[5] = type;
            return objectLink(link);
          },
          disconnect() {
            calls.push([`subgraph.${direction}.disconnect`, name]);
            if (direction === "Output") {
              TestNode.prototype.disconnectInput.call(ioNode, slots.indexOf(slot));
            } else {
              for (const link of [...subgraph.links]) {
                if (link[1] === ioNode.id && link[2] === slots.indexOf(slot)) {
                  subgraph.getNodeById(link[3]).disconnectInput(link[4]);
                }
              }
            }
          },
        };
        slots.push(slot);
        syncHosts();
        return slot;
      };
      subgraph[`rename${direction}`] = (slot, label) => {
        calls.push([`subgraph.rename${direction}`, slot.name, label]);
        slot.label = label;
        syncHosts();
      };
      subgraph[`remove${direction}`] = (slot) => {
        calls.push([`subgraph.remove${direction}`, slot.name]);
        slot.disconnect();
        slots.splice(slots.indexOf(slot), 1);
        syncHosts();
      };
    }
    subgraph.asSerialisable = () => ({
      ...serializeGraph.call(subgraph),
      name: subgraph.name,
      inputs: subgraph.inputs.map(slotData),
      outputs: subgraph.outputs.map(slotData),
      inputNode: { id: subgraph.inputNode.id },
      outputNode: { id: subgraph.outputNode.id },
      links: subgraph.links.map(objectLink),
    });
    return subgraph;
  }

  root.subgraphs = new Map();
  root.serialize = () => ({
    ...serializeGraph.call(root),
    definitions: { subgraphs: [...root.subgraphs.values()].map((graph) => graph.asSerialisable()) },
  });
  root.configure = (snapshot) => {
    calls.push("root.configure");
    configureGraph.call(root, snapshot);
    root.subgraphs.clear();
    for (const data of snapshot.definitions.subgraphs) {
      const subgraph = createSubgraph(data.id);
      configureGraph.call(subgraph, { ...data, links: [] });
      subgraph.name = data.name;
      for (const direction of ["Input", "Output"]) {
        for (const slot of data[`${direction.toLowerCase()}s`]) {
          Object.assign(subgraph[`add${direction}`](slot.name, slot.type), slot);
        }
      }
      for (const link of data.links) {
        const source = subgraph.getNodeById(link.origin_id) ?? subgraph.inputNode;
        const target = subgraph.getNodeById(link.target_id) ?? subgraph.outputNode;
        TestNode.prototype.connect.call(source, link.origin_slot, target, link.target_slot);
        subgraph.links[subgraph.links.length - 1] = [
          link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type,
        ];
      }
      subgraph.lastLinkId = data.last_link_id;
      root.subgraphs.set(subgraph.id, subgraph);
    }
    for (const data of snapshot.nodes) {
      if (data.subgraph_id) bindHost(root.getNodeById(data.id), root.subgraphs.get(data.subgraph_id));
    }
  };
  canvas.setGraph = function (graph) {
    calls.push(["canvas.setGraph", graph.id]);
    this.graph = graph;
    this.selectedItems.clear();
  };
  canvas.openSubgraph = function (graph, host) {
    calls.push(["canvas.openSubgraph", graph.id, host.id]);
    this.subgraph = graph;
    this.setGraph(graph);
  };
  Object.defineProperty(canvas, "positionableItems", {
    get() { return [...this.graph.nodes, ...this.graph.groups]; },
  });
  const subgraph = createSubgraph("subgraph-1");
  root.subgraphs.set(subgraph.id, subgraph);
  subgraph.addInput("entry", "NUMBER");
  subgraph.addOutput("exit", "NUMBER");
  const inner = new TestNode("OpenBioSummary");
  inner.inputs[0].type = inner.outputs[0].type = "NUMBER";
  subgraph.add(inner);
  const host = new TestNode(subgraph.id);
  bindHost(host, subgraph);
  root.add(host);
  calls.length = 0;
  return { ...fixture, root, subgraph, inner, host };
}
