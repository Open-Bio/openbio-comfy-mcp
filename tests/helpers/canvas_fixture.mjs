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

    get boundingRect() {
      return [this.pos[0], this.pos[1], this.size[0], this.size[1]];
    }

    move(deltaX, deltaY, skipChildren = false) {
      calls.push(["node.move", this.id, deltaX, deltaY, skipChildren]);
      this.pos[0] += deltaX;
      this.pos[1] += deltaY;
    }

    setPos(x, y) {
      calls.push(["node.setPos", this.id, x, y]);
      this.pos[0] = x;
      this.pos[1] = y;
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

  class TestGroup {
    constructor(title = "Group") {
      this.id = -1;
      this.title = title || "Group";
      this.color = "#AAA";
      this.flags = {};
      this._bounding = [10, 10, 140, 80];
      this._nodes = [];
      this._children = new Set();
      this.graph = undefined;
    }

    get pos() {
      return this._bounding.slice(0, 2);
    }

    set pos(value) {
      this._bounding[0] = value[0];
      this._bounding[1] = value[1];
    }

    get size() {
      return this._bounding.slice(2, 4);
    }

    set size(value) {
      this._bounding[2] = Math.max(140, value[0]);
      this._bounding[3] = Math.max(80, value[1]);
    }

    get boundingRect() {
      return this._bounding;
    }

    get nodes() {
      return this._nodes;
    }

    get children() {
      return this._children;
    }

    get pinned() {
      return Boolean(this.flags.pinned);
    }

    serialize() {
      return {
        id: this.id,
        title: this.title,
        bounding: [...this._bounding],
        color: this.color,
        flags: structuredClone(this.flags),
      };
    }

    configure(data) {
      this.id = data.id;
      this.title = data.title;
      this._bounding = [...data.bounding];
      this.color = data.color;
      this.flags = structuredClone(data.flags ?? {});
    }

    pin(value) {
      if (value) this.flags.pinned = true;
      else delete this.flags.pinned;
    }

    resizeTo(items, padding = 10) {
      const bounds = [...items].map((item) => item.boundingRect);
      if (bounds.length === 0) return;
      const left = Math.min(...bounds.map((rect) => rect[0])) - padding;
      const top = Math.min(...bounds.map((rect) => rect[1])) - padding;
      const right = Math.max(...bounds.map((rect) => rect[0] + rect[2])) + padding;
      const bottom = Math.max(...bounds.map((rect) => rect[1] + rect[3])) + padding;
      this._bounding = [left, top - 30, right - left, bottom - top + 30];
    }

    recomputeInsideNodes(maxDepth = 100, visited = new Set()) {
      calls.push(["group.recomputeInsideNodes", this.id]);
      if (maxDepth <= 0 || visited.has(this.id)) return;
      visited.add(this.id);
      this._nodes.length = 0;
      this._children.clear();
      if (!this.graph) return;
      const [left, top, width, height] = this._bounding;
      const containsCenter = (rect) => {
        const centerX = rect[0] + rect[2] * 0.5;
        const centerY = rect[1] + rect[3] * 0.5;
        return centerX >= left
          && centerX < left + width
          && centerY >= top
          && centerY < top + height;
      };
      const containsRect = (rect) => (
        rect[0] >= left
        && rect[1] >= top
        && rect[0] + rect[2] <= left + width
        && rect[1] + rect[3] <= top + height
      );
      for (const node of this.graph.nodes) {
        if (!containsCenter(node.boundingRect)) continue;
        this._nodes.push(node);
        this._children.add(node);
      }
      const containedGroups = this.graph.groups.filter(
        (group) => group !== this && containsRect(group.boundingRect),
      );
      for (const group of containedGroups) this._children.add(group);
      for (const group of containedGroups) group.recomputeInsideNodes(maxDepth - 1, visited);
      this.graph.groups.sort((leftGroup, rightGroup) => {
        if (leftGroup === this) return this._children.has(rightGroup) ? -1 : 0;
        if (rightGroup === this) return this._children.has(leftGroup) ? 1 : 0;
        return 0;
      });
    }

    move(deltaX, deltaY, skipChildren = false) {
      calls.push(["group.move", this.id, deltaX, deltaY, skipChildren]);
      if (this.pinned) return;
      this._bounding[0] += deltaX;
      this._bounding[1] += deltaY;
      if (skipChildren) return;
      for (const child of this._children) child.move(deltaX, deltaY);
    }
  }

  class TestGraph {
    constructor(snapshot) {
      this.id = "canvas-root";
      this.nodes = [];
      this.groups = [];
      this.links = [];
      this.lastNodeId = 0;
      this.lastGroupId = 0;
      this.lastLinkId = 0;
      if (snapshot) this.configure(snapshot);
    }

    add(node) {
      if (node instanceof TestGroup) {
        if (node.id === -1) node.id = ++this.lastGroupId;
        this.lastGroupId = Math.max(this.lastGroupId, Number(node.id));
        node.graph = this;
        this.groups.push(node);
        return node;
      }
      if (node.id === -1) node.id = ++this.lastNodeId;
      this.lastNodeId = Math.max(this.lastNodeId, Number(node.id));
      node.graph = this;
      this.nodes.push(node);
      return node;
    }
    remove(node) {
      if (node instanceof TestGroup) {
        this.groups = this.groups.filter((candidate) => candidate !== node);
        node.graph = undefined;
        return;
      }
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
        last_group_id: this.lastGroupId,
        last_link_id: this.lastLinkId,
        nodes: this.nodes.map((node) => node.serialize()),
        groups: this.groups.map((group) => group.serialize()),
        links: structuredClone(this.links),
      };
    }
    configure(snapshot) {
      this.id = snapshot.id;
      this.lastNodeId = snapshot.last_node_id;
      this.lastGroupId = snapshot.last_group_id ?? 0;
      this.lastLinkId = snapshot.last_link_id;
      this.nodes = [];
      this.groups = [];
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
      for (const data of snapshot.groups ?? []) {
        const group = new TestGroup();
        group.configure(data);
        this.add(group);
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
      this.groups = [];
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
      fitToBounds(bounds) {
        calls.push(["canvas.ds.fitToBounds", Array.from(bounds)]);
        this.state.scale = 0.75;
        this.state.offset = [-bounds[0], -bounds[1]];
      },
      computeVisibleArea() {
        calls.push("canvas.ds.computeVisibleArea");
        this.visible_area = new Float64Array([
          -this.state.offset[0],
          -this.state.offset[1],
          900 / this.state.scale,
          700 / this.state.scale,
        ]);
      },
    },
    get positionableItems() { return [...graph.nodes, ...graph.groups]; },
    emitBeforeChange() { calls.push("canvas.emitBeforeChange"); },
    emitAfterChange() { calls.push("canvas.emitAfterChange"); },
    deselectAll() {
      calls.push("canvas.deselectAll");
      for (const item of this.selectedItems) item.selected = false;
      this.selectedItems.clear();
      this.setDirty();
    },
    selectItems(items, addToCurrentSelection = false) {
      calls.push(["canvas.selectItems", items.map(({ id }) => String(id)), addToCurrentSelection]);
      if (!addToCurrentSelection) this.deselectAll();
      for (const item of items) {
        item.selected = true;
        this.selectedItems.add(item);
        if (item instanceof TestGroup) item.recomputeInsideNodes();
      }
      this.setDirty();
    },
    fitViewToSelectionAnimated(options = {}) {
      calls.push(["canvas.fitViewToSelectionAnimated", options]);
    },
    moveChildNodesInGroupVueMode(items, deltaX, deltaY) {
      calls.push(["canvas.moveChildNodesInGroupVueMode", deltaX, deltaY]);
      for (const item of items) {
        if (item instanceof TestNode) item.setPos(item.pos[0] + deltaX, item.pos[1] + deltaY);
        else item.move(deltaX, deltaY, true);
      }
    },
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
    LGraphGroup: TestGroup,
    createNode(type) {
      return type === "Missing" ? null : new TestNode(type);
    },
  };

  return {
    app,
    canvas,
    graph,
    existing,
    activeWorkflow,
    LiteGraph,
    calls,
    TestNode,
    TestGroup,
  };
}
