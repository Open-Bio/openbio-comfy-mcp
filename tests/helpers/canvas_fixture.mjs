export function createCanvasFixture() {
  const calls = [];

  class TestNode {
    constructor(type) {
      this.id = -1;
      this.type = type;
      this.pos = [0, 0];
      this.size = [180, 80];
      this.properties = {};
      this.widgets = [{ name: "value", value: "", callback(value) { calls.push(["widget", value]); } }];
      this.inputs = [{ name: "in", link: null }];
      this.outputs = [{ name: "out", links: [] }];
    }

    serialize() {
      return {
        id: this.id,
        type: this.type,
        pos: [...this.pos],
        size: [...this.size],
        properties: structuredClone(this.properties),
        widgets_values: this.widgets.map((widget) => structuredClone(widget.value)),
      };
    }

    connect(output, target, input) {
      const outputIndex = typeof output === "string" ? this.outputs.findIndex((slot) => slot.name === output) : output;
      const inputIndex = typeof input === "string" ? target.inputs.findIndex((slot) => slot.name === input) : input;
      if (outputIndex < 0 || inputIndex < 0) return null;
      const id = ++this.graph.lastLinkId;
      const link = [id, this.id, outputIndex, target.id, inputIndex, "*"];
      this.graph.links.push(link);
      this.outputs[outputIndex].links.push(id);
      target.inputs[inputIndex].link = id;
      return link;
    }

    disconnectInput(input) {
      const index = typeof input === "string" ? this.inputs.findIndex((slot) => slot.name === input) : input;
      if (index < 0 || index >= this.inputs.length) return false;
      const linkId = this.inputs[index]?.link;
      if (linkId == null) return true;
      this.graph.links = this.graph.links.filter((link) => link[0] !== linkId);
      for (const node of this.graph.nodes) {
        for (const output of node.outputs) output.links = output.links.filter((id) => id !== linkId);
      }
      this.inputs[index].link = null;
      return true;
    }
  }

  class TestGraph {
    constructor(snapshot) {
      this.id = "canvas-root";
      this.nodes = [];
      this.links = [];
      this.lastNodeId = 0;
      this.lastLinkId = 0;
      if (snapshot) this.configure(snapshot);
    }

    add(node) {
      if (node.id === -1) node.id = ++this.lastNodeId;
      this.lastNodeId = Math.max(this.lastNodeId, Number(node.id));
      node.graph = this;
      this.nodes.push(node);
      return node;
    }
    remove(node) {
      if (node.ignore_remove) return;
      this.nodes = this.nodes.filter((candidate) => candidate !== node);
      this.links = this.links.filter((link) => link[1] !== node.id && link[3] !== node.id);
    }
    getNodeById(id) {
      return this.nodes.find((node) => String(node.id) === String(id)) ?? null;
    }
    serialize() {
      return {
        id: this.id,
        last_node_id: this.lastNodeId,
        last_link_id: this.lastLinkId,
        nodes: this.nodes.map((node) => node.serialize()),
        links: structuredClone(this.links),
      };
    }
    configure(snapshot) {
      this.id = snapshot.id;
      this.lastNodeId = snapshot.last_node_id;
      this.lastLinkId = snapshot.last_link_id;
      this.nodes = [];
      this.links = [];
      for (const data of snapshot.nodes) {
        const node = new TestNode(data.type);
        node.id = data.id;
        node.pos = [...data.pos];
        node.size = [...data.size];
        node.properties = structuredClone(data.properties ?? {});
        data.widgets_values?.forEach((value, index) => { node.widgets[index].value = structuredClone(value); });
        this.add(node);
      }
      for (const link of snapshot.links) {
        const source = this.getNodeById(link[1]);
        const target = this.getNodeById(link[3]);
        source.connect(link[2], target, link[4]);
        this.links.at(-1)[0] = link[0];
      }
      this.lastLinkId = snapshot.last_link_id;
    }
    beforeChange() { calls.push("graph.beforeChange"); }
    afterChange() { calls.push("graph.afterChange"); }
    setDirtyCanvas() { calls.push("graph.setDirtyCanvas"); }
    clear() {
      this.nodes = [];
      this.links = [];
    }
  }

  const graph = new TestGraph();

  const existing = new TestNode("OpenBioLoad");
  existing.id = 7;
  existing.pos = [40, 80];
  graph.add(existing);

  const canvas = {
    graph,
    selectedItems: new Set([existing]),
    ds: {
      state: { scale: 1.25, offset: [12, 24] },
      visible_area: new Float64Array([10, 20, 900, 700]),
    },
    emitBeforeChange() { calls.push("canvas.emitBeforeChange"); },
    emitAfterChange() { calls.push("canvas.emitAfterChange"); },
    centerOnNode(node) { calls.push(["canvas.centerOnNode", node.id]); },
    setDirty() { calls.push("canvas.setDirty"); },
  };

  const activeWorkflow = {
    path: "workflows/openbio.json",
    changeTracker: { activeState: { id: "workflow-123" } },
  };
  const app = {
    canvas,
    extensionManager: { workflow: { activeWorkflow } },
  };
  const LiteGraph = {
    createNode(type) {
      return type === "Missing" ? null : new TestNode(type);
    },
  };

  return { app, canvas, graph, existing, activeWorkflow, LiteGraph, calls, TestNode };
}
