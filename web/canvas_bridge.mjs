function clone(value) {
  return structuredClone(value);
}

export function workflowIdentity(workflow) {
  return String(
    workflow?.changeTracker?.activeState?.id
      ?? workflow?.activeState?.id
      ?? workflow?.path
      ?? "unsaved",
  );
}

export function readLiveCanvasIdentity(app, pageId) {
  const workflow = app.extensionManager.workflow.activeWorkflow;
  const workflowId = workflowIdentity(workflow);
  const graphId = String(app.canvas.graph?.id ?? "root");
  return {
    page_id: String(pageId),
    workflow_id: workflowId,
    workflow_path: workflow?.path ?? null,
    graph_id: graphId,
    canvas_id: canvasIdentity(String(pageId), workflowId, graphId),
  };
}

export function canvasIdentity(pageId, workflowId, graphId) {
  return `${pageId}:${workflowId || "unsaved"}:${graphId || "root"}`;
}

function revisionState(snapshot) {
  return {
    nodes: snapshot.nodes ?? [],
    links: snapshot.links ?? [],
    groups: snapshot.groups ?? [],
    reroutes: snapshot.reroutes ?? [],
    legacy_reroutes: snapshot.extra?.reroutes ?? [],
    name: snapshot.name,
    inputs: snapshot.inputs,
    outputs: snapshot.outputs,
    widgets: snapshot.widgets,
    inputNode: snapshot.inputNode,
    outputNode: snapshot.outputNode,
    subgraphs: snapshot.definitions?.subgraphs?.map(revisionState),
  };
}

function revisionOf(snapshot) {
  const text = JSON.stringify(revisionState(snapshot));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1-${hash.toString(16).padStart(8, "0")}`;
}

export class CanvasBridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CanvasBridgeError";
    this.code = code;
    this.details = details;
  }
}

function bridgeError(code, message, details) {
  return new CanvasBridgeError(code, message, details);
}

function resolveNode(graph, reference, tempIds) {
  const nodeId = Object.hasOwn(tempIds, reference) ? tempIds[reference] : reference;
  const node = graph.getNodeById(nodeId);
  if (!node) throw bridgeError("node_not_found", `Node does not exist: ${reference}`, { reference });
  return node;
}

function resolveGroup(graph, reference, tempIds) {
  const groupId = Object.hasOwn(tempIds, reference) ? tempIds[reference] : reference;
  const group = graph.groups?.find((candidate) => String(candidate.id) === String(groupId));
  if (!group) {
    throw bridgeError("group_not_found", `Group does not exist: ${reference}`, { reference });
  }
  return group;
}

function inputWidget(node, inputName) {
  const widget = node.widgets?.find((candidate) => candidate.name === inputName);
  if (!widget) {
    throw bridgeError("input_not_found", `Input does not exist: ${node.id}.${inputName}`, {
      node_id: String(node.id),
      input_name: inputName,
    });
  }
  return widget;
}

function inputSlot(node, inputName) {
  const slot = node.inputs?.find((candidate) => candidate.name === inputName);
  if (!slot) {
    throw bridgeError("input_not_found", `Input does not exist: ${node.id}.${inputName}`, {
      node_id: String(node.id),
      input_name: inputName,
    });
  }
  return slot;
}

function outputSlot(node, outputName) {
  const slot = node.outputs?.find((candidate) => candidate.name === outputName);
  if (!slot) {
    throw bridgeError("output_not_found", `Output does not exist: ${node.id}.${outputName}`, {
      node_id: String(node.id),
      output_name: outputName,
    });
  }
  return slot;
}

function setInput(node, inputName, value) {
  const widget = inputWidget(node, inputName);
  widget.value = clone(value);
  widget.callback?.(widget.value);
}

function assertNodeRemovable(node) {
  if (node.ignore_remove || node.block_delete || node.removable === false) {
    throw bridgeError("removal_rejected", `Node cannot be removed: ${node.id}`, {
      node_id: String(node.id),
    });
  }
}

function setGroupBounding(group, bounding) {
  group.pos = [bounding[0], bounding[1]];
  group.size = [bounding[2], bounding[3]];
}

function updateGroup(group, operation) {
  if (Object.hasOwn(operation, "title")) group.title = operation.title;
  if (Object.hasOwn(operation, "bounding")) setGroupBounding(group, operation.bounding);
  if (Object.hasOwn(operation, "color")) {
    if (operation.color === null) delete group.color;
    else group.color = operation.color;
  }
  if (Object.hasOwn(operation, "pinned")) group.pin(operation.pinned);
  if (Object.hasOwn(operation, "bounding")) group.recomputeInsideNodes();
}

function assertGroupMovable(group, pinned = group.pinned, reference = group.id) {
  if (pinned) {
    throw bridgeError("movement_rejected", `Pinned group cannot be moved: ${reference}`, {
      group_id: String(reference),
    });
  }
}

function draggedGroupItems(group) {
  // Match LGraphCanvas drag semantics: flatten and deduplicate descendants,
  // then move every item with child recursion disabled.
  const items = new Set();
  const addItem = (item) => {
    if (items.has(item) || item.pinned) return;
    items.add(item);
    for (const child of item.children ?? []) addItem(child);
  };
  addItem(group);
  return items;
}

function plannedNode(context, reference) {
  const node = Object.hasOwn(context.preparedNodes, reference)
    ? context.preparedNodes[reference]
    : context.graph.getNodeById(reference);
  if (!node || context.removedNodes.has(node)) {
    throw bridgeError("node_not_found", `Node does not exist: ${reference}`, { reference });
  }
  return node;
}

function plannedGroup(context, reference) {
  const group = Object.hasOwn(context.preparedGroups, reference)
    ? context.preparedGroups[reference]
    : context.graph.groups?.find((candidate) => String(candidate.id) === String(reference));
  if (!group || context.removedGroups.has(group)) {
    throw bridgeError("group_not_found", `Group does not exist: ${reference}`, { reference });
  }
  return group;
}

function assertUniqueTempRef(context, tempRef) {
  if (Object.hasOwn(context.preparedNodes, tempRef) || Object.hasOwn(context.preparedGroups, tempRef)) {
    throw bridgeError("duplicate_temp_ref", `Duplicate temp_ref: ${tempRef}`);
  }
}

function assertStructuralOperationOrder(operations) {
  const index = operations.findIndex(({ op }) => (
    op === "convert_to_subgraph" || op === "unpack_subgraph"
  ));
  if (index !== -1 && index !== operations.length - 1) {
    throw bridgeError(
      "invalid_patch",
      "A subgraph conversion or unpack must be the final operation; inspect again before editing its new nodes",
    );
  }
}

function requireSubgraph(graph) {
  if (!graph.inputNode || !graph.outputNode) {
    throw bridgeError("subgraph_required", "This operation requires an active subgraph");
  }
}

function subgraphPort(ports, name, direction) {
  const port = ports.find((candidate) => candidate.name === name);
  if (!port) {
    throw bridgeError("port_not_found", `Subgraph ${direction} does not exist: ${name}`);
  }
  return port;
}

function linkEndpoint(context, reference, name, side, planning = false) {
  const direction = side === "output" ? "input" : "output";
  const ioNode = context.graph[`${direction}Node`];
  if (ioNode && String(ioNode.id) === String(reference)) {
    const ports = planning ? context.plannedPorts[direction] : context.graph[`${direction}s`];
    return { node: ioNode, slot: subgraphPort(ports, name, direction) };
  }
  const node = planning
    ? plannedNode(context, reference)
    : resolveNode(context.graph, reference, context.idMap);
  return { node, slot: side === "output" ? outputSlot(node, name) : inputSlot(node, name) };
}

const OPERATION_HANDLERS = new Map([
  ["add_node", {
    preflight(context, operation) {
      assertUniqueTempRef(context, operation.temp_ref);
      const node = context.LiteGraph.createNode(operation.class_type);
      if (!node) {
        throw bridgeError("node_type_not_found", `Node type is not installed: ${operation.class_type}`, {
          class_type: operation.class_type,
        });
      }
      context.preparedNodes[operation.temp_ref] = node;
    },
    apply(context, operation) {
      const node = context.preparedNodes[operation.temp_ref];
      if (operation.pos) {
        node.pos = clone(operation.pos);
      } else {
        const area = context.canvas.ds.visible_area ?? context.canvas.visible_area;
        node.pos = [
          area[0] + area[2] / 2 - node.size[0] / 2 + context.unpositionedNodes * 40,
          area[1] + area[3] / 2 - node.size[1] / 2,
        ];
        context.unpositionedNodes += 1;
      }
      context.graph.add(node);
      context.idMap[operation.temp_ref] = String(node.id);
      context.changedNodeIds.add(String(node.id));
    },
  }],
  ["add_group", {
    preflight(context, operation) {
      assertUniqueTempRef(context, operation.temp_ref);
      const group = new context.LiteGraph.LGraphGroup(operation.title);
      context.preparedGroups[operation.temp_ref] = group;
      context.plannedGroupPinned.set(group, operation.pinned ?? group.pinned);
    },
    apply(context, operation) {
      const group = context.preparedGroups[operation.temp_ref];
      if (operation.bounding) {
        setGroupBounding(group, operation.bounding);
      } else {
        const area = context.canvas.ds.visible_area ?? context.canvas.visible_area;
        group.pos = [
          area[0] + area[2] / 2 - group.size[0] / 2,
          area[1] + area[3] / 2 - group.size[1] / 2,
        ];
      }
      if (Object.hasOwn(operation, "color")) group.color = operation.color;
      if (Object.hasOwn(operation, "pinned")) group.pin(operation.pinned);
      context.graph.add(group);
      group.recomputeInsideNodes();
      context.groupIdMap[operation.temp_ref] = String(group.id);
      context.changedGroupIds.add(String(group.id));
    },
  }],
  ["update_group", {
    preflight(context, operation) {
      const group = plannedGroup(context, operation.group_id);
      if (Object.hasOwn(operation, "pinned")) {
        context.plannedGroupPinned.set(group, operation.pinned);
      }
    },
    apply(context, operation) {
      const group = resolveGroup(context.graph, operation.group_id, context.groupIdMap);
      updateGroup(group, operation);
      context.changedGroupIds.add(String(group.id));
    },
  }],
  ["move_group", {
    preflight(context, operation) {
      const group = plannedGroup(context, operation.group_id);
      const pinned = context.plannedGroupPinned.has(group)
        ? context.plannedGroupPinned.get(group)
        : group.pinned;
      assertGroupMovable(group, pinned, operation.group_id);
    },
    apply(context, operation) {
      const group = resolveGroup(context.graph, operation.group_id, context.groupIdMap);
      assertGroupMovable(group);
      group.recomputeInsideNodes();
      const items = draggedGroupItems(group);
      const [deltaX, deltaY] = operation.delta;
      if (context.LiteGraph.vueNodesMode) {
        context.canvas.moveChildNodesInGroupVueMode(items, deltaX, deltaY);
      } else {
        for (const item of items) item.move(deltaX, deltaY, true);
      }
      for (const item of items) {
        if (context.graph.getNodeById(item.id) === item) {
          context.changedNodeIds.add(String(item.id));
        } else if (context.graph.groups?.includes(item)) {
          context.changedGroupIds.add(String(item.id));
        }
      }
    },
  }],
  ["remove_group", {
    preflight(context, operation) {
      context.removedGroups.add(plannedGroup(context, operation.group_id));
    },
    apply(context, operation) {
      const group = resolveGroup(context.graph, operation.group_id, context.groupIdMap);
      context.changedGroupIds.add(String(group.id));
      context.graph.remove(group);
      if (context.graph.groups?.includes(group)) {
        throw bridgeError("removal_rejected", `ComfyUI rejected removal of group: ${group.id}`, {
          group_id: String(group.id),
        });
      }
    },
  }],
  ["fit_group_to_nodes", {
    preflight(context, operation) {
      plannedGroup(context, operation.group_id);
      for (const reference of operation.node_ids) plannedNode(context, reference);
    },
    apply(context, operation) {
      const group = resolveGroup(context.graph, operation.group_id, context.groupIdMap);
      const nodes = operation.node_ids.map(
        (reference) => resolveNode(context.graph, reference, context.idMap),
      );
      group.resizeTo(nodes, operation.padding ?? 10);
      group.recomputeInsideNodes();
      context.changedGroupIds.add(String(group.id));
    },
  }],
  ["remove_node", {
    preflight(context, operation) {
      const node = plannedNode(context, operation.node_id);
      assertNodeRemovable(node);
      context.removedNodes.add(node);
    },
    apply(context, operation) {
      const node = resolveNode(context.graph, operation.node_id, context.idMap);
      assertNodeRemovable(node);
      context.changedNodeIds.add(String(node.id));
      context.graph.remove(node);
      if (context.graph.getNodeById(node.id)) {
        throw bridgeError("removal_rejected", `ComfyUI rejected removal of node: ${node.id}`, {
          node_id: String(node.id),
        });
      }
    },
  }],
  ["set_input", {
    preflight(context, operation) {
      inputWidget(plannedNode(context, operation.node_id), operation.input_name);
    },
    apply(context, operation) {
      const node = resolveNode(context.graph, operation.node_id, context.idMap);
      context.changedNodeIds.add(String(node.id));
      setInput(node, operation.input_name, operation.value);
    },
  }],
  ["connect", {
    preflight(context, operation) {
      const source = linkEndpoint(context, operation.source, operation.output_name, "output", true);
      const target = linkEndpoint(context, operation.target, operation.input_name, "input", true);
      // Native SubgraphInput.connect requires an LGraphNode target; boundary passthrough is unsupported.
      const passthrough = source.node === context.graph.inputNode && target.node === context.graph.outputNode;
      if (
        passthrough || source.node === target.node
        || context.LiteGraph.isValidConnection?.(source.slot.type, target.slot.type) === false
      ) {
        throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
      }
    },
    apply(context, operation) {
      const source = linkEndpoint(context, operation.source, operation.output_name, "output");
      const target = linkEndpoint(context, operation.target, operation.input_name, "input");
      let link;
      if (source.node === context.graph.inputNode) link = source.slot.connect(target.slot, target.node);
      else if (target.node === context.graph.outputNode) link = target.slot.connect(source.slot, source.node);
      else link = source.node.connect(operation.output_name, target.node, operation.input_name);
      if (!link) throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
      context.changedNodeIds.add(String(source.node.id));
      context.changedNodeIds.add(String(target.node.id));
    },
  }],
  ["disconnect", {
    preflight(context, operation) {
      linkEndpoint(context, operation.target, operation.input_name, "input", true);
    },
    apply(context, operation) {
      const target = linkEndpoint(context, operation.target, operation.input_name, "input");
      context.changedNodeIds.add(String(target.node.id));
      if (target.node === context.graph.outputNode) target.slot.disconnect();
      else if (target.node.disconnectInput(operation.input_name) === false) {
        throw bridgeError("connection_rejected", "ComfyUI rejected the requested disconnection");
      }
    },
  }],
  ["move_node", {
    preflight(context, operation) {
      plannedNode(context, operation.node_id);
    },
    apply(context, operation) {
      const node = resolveNode(context.graph, operation.node_id, context.idMap);
      context.changedNodeIds.add(String(node.id));
      node.pos = clone(operation.pos);
    },
  }],
  ["convert_to_subgraph", {
    preflight(context, operation) {
      if (!Array.isArray(operation.node_ids) || operation.node_ids.length === 0) {
        throw bridgeError("invalid_patch", "Subgraph conversion requires a non-empty node_ids array");
      }
      assertUniqueTempRef(context, operation.temp_ref);
      for (const reference of operation.node_ids) {
        assertNodeRemovable(plannedNode(context, reference));
      }
    },
    apply(context, operation) {
      const nodes = operation.node_ids.map((reference) => resolveNode(context.graph, reference, context.idMap));
      for (const node of nodes) assertNodeRemovable(node);
      const { subgraph, node } = context.graph.convertToSubgraph(new Set(nodes));
      if (nodes.some((oldNode) => context.graph.getNodeById(oldNode.id) === oldNode)) {
        throw bridgeError("removal_rejected", "ComfyUI rejected removal of nodes during subgraph conversion");
      }
      if (Object.hasOwn(operation, "title")) {
        subgraph.name = operation.title;
        node.title = operation.title;
      }
      context.idMap[operation.temp_ref] = String(node.id);
      for (const oldNode of nodes) context.changedNodeIds.add(String(oldNode.id));
      context.changedNodeIds.add(String(node.id));
    },
  }],
  ["unpack_subgraph", {
    preflight(context, operation) {
      const node = plannedNode(context, operation.node_id);
      if (!node.isSubgraphNode?.()) {
        throw bridgeError("subgraph_required", `Node is not a subgraph: ${operation.node_id}`);
      }
      assertNodeRemovable(node);
    },
    apply(context, operation) {
      const node = resolveNode(context.graph, operation.node_id, context.idMap);
      assertNodeRemovable(node);
      const nodesBefore = new Set(context.graph.nodes);
      const groupsBefore = new Set(context.graph.groups);
      context.graph.unpackSubgraph(node);
      if (context.graph.getNodeById(node.id) === node) {
        throw bridgeError("removal_rejected", "ComfyUI rejected removal of the unpacked subgraph node");
      }
      context.changedNodeIds.add(String(node.id));
      for (const added of context.graph.nodes) {
        if (!nodesBefore.has(added)) context.changedNodeIds.add(String(added.id));
      }
      for (const added of context.graph.groups) {
        if (!groupsBefore.has(added)) context.changedGroupIds.add(String(added.id));
      }
    },
  }],
  ["add_subgraph_port", {
    preflight(context, operation) {
      requireSubgraph(context.graph);
      const ports = context.plannedPorts[operation.direction];
      if (ports.some((port) => port.name === operation.name)) {
        throw bridgeError("duplicate_port", `Subgraph ${operation.direction} already exists: ${operation.name}`);
      }
      ports.push({ name: operation.name, type: operation.type });
    },
    apply(context, operation) {
      if (operation.direction === "input") context.graph.addInput(operation.name, operation.type);
      else context.graph.addOutput(operation.name, operation.type);
    },
  }],
  ["rename_subgraph_port", {
    preflight(context, operation) {
      requireSubgraph(context.graph);
      subgraphPort(context.plannedPorts[operation.direction], operation.name, operation.direction);
    },
    apply(context, operation) {
      const port = subgraphPort(context.graph[`${operation.direction}s`], operation.name, operation.direction);
      if (operation.direction === "input") context.graph.renameInput(port, operation.label);
      else context.graph.renameOutput(port, operation.label);
    },
  }],
  ["remove_subgraph_port", {
    preflight(context, operation) {
      requireSubgraph(context.graph);
      const ports = context.plannedPorts[operation.direction];
      const port = subgraphPort(ports, operation.name, operation.direction);
      ports.splice(ports.indexOf(port), 1);
    },
    apply(context, operation) {
      const ports = context.graph[`${operation.direction}s`];
      const port = subgraphPort(ports, operation.name, operation.direction);
      if (operation.direction === "input") context.graph.removeInput(port);
      else context.graph.removeOutput(port);
      if (ports.includes(port)) {
        throw bridgeError("removal_rejected", `ComfyUI rejected removal of subgraph ${operation.direction}: ${operation.name}`);
      }
    },
  }],
]);

function operationHandler(operation) {
  const handler = OPERATION_HANDLERS.get(operation.op);
  if (!handler) {
    throw bridgeError("unsupported_operation", `Unsupported canvas operation: ${operation.op}`, {
      operation: operation.op,
    });
  }
  return handler;
}

function preflightOperations(graph, LiteGraph, operations) {
  assertStructuralOperationOrder(operations);
  const context = {
    graph,
    LiteGraph,
    preparedNodes: {},
    preparedGroups: {},
    removedNodes: new Set(),
    removedGroups: new Set(),
    plannedGroupPinned: new Map(),
    plannedPorts: {
      input: (graph.inputs ?? []).map(({ name, type }) => ({ name, type })),
      output: (graph.outputs ?? []).map(({ name, type }) => ({ name, type })),
    },
  };
  const plan = [];
  for (const operation of operations) {
    const handler = operationHandler(operation);
    handler.preflight(context, operation);
    plan.push({ handler, operation });
  }
  return {
    plan,
    preparedNodes: context.preparedNodes,
    preparedGroups: context.preparedGroups,
  };
}

function applyOperations(canvas, graph, LiteGraph, plan, preparedNodes, preparedGroups) {
  const context = {
    canvas,
    graph,
    LiteGraph,
    preparedNodes,
    preparedGroups,
    idMap: {},
    groupIdMap: {},
    changedNodeIds: new Set(),
    changedGroupIds: new Set(),
    unpositionedNodes: 0,
  };
  for (const { handler, operation } of plan) handler.apply(context, operation);
  graph.setDirtyCanvas(true, true);
  return {
    idMap: context.idMap,
    groupIdMap: context.groupIdMap,
    changedNodeIds: [...context.changedNodeIds].sort(),
    changedGroupIds: [...context.changedGroupIds].sort(),
  };
}

function canonicalSelection(canvas, graph) {
  const items = [];
  for (const item of canvas.selectedItems ?? []) {
    if (item?.id == null) continue;
    let kind = "item";
    if (graph.getNodeById(item.id) === item) kind = "node";
    else if (graph.groups?.includes?.(item)) kind = "group";
    else if (graph.reroutes?.get?.(item.id) === item) kind = "reroute";
    items.push({ kind, id: String(item.id) });
  }
  return items.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function canonicalViewport(canvas) {
  return {
    scale: canvas.ds.state.scale,
    offset: Array.from(canvas.ds.state.offset),
    visible_area: Array.from(canvas.ds.visible_area),
  };
}

const FIT_VIEW_ANIMATION_MS = 350;
const FIT_VIEW_TIMEOUT_MS = FIT_VIEW_ANIMATION_MS + 250;

function fitViewBounds(canvas) {
  const items = canvas.selectedItems?.size
    ? canvas.selectedItems
    : canvas.positionableItems;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const item of items) {
    const rect = item.boundingRect;
    bounds[0] = Math.min(bounds[0], rect[0]);
    bounds[1] = Math.min(bounds[1], rect[1]);
    bounds[2] = Math.max(bounds[2], rect[0] + rect[2]);
    bounds[3] = Math.max(bounds[3], rect[1] + rect[3]);
  }
  if (!bounds.every(Number.isFinite)) return null;
  return [
    bounds[0] - 10,
    bounds[1] - 10,
    bounds[2] - bounds[0] + 20,
    bounds[3] - bounds[1] + 20,
  ];
}

function waitForFitViewAnimation() {
  if (typeof globalThis.requestAnimationFrame !== "function") return Promise.resolve(false);
  const startedAt = globalThis.performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let animationFinished = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(completed);
    };
    const waitForFrame = (timestamp) => {
      if (settled) return;
      if (animationFinished) {
        finish(true);
      } else {
        animationFinished = timestamp - startedAt >= FIT_VIEW_ANIMATION_MS;
        globalThis.requestAnimationFrame(waitForFrame);
      }
    };
    const timeoutId = globalThis.setTimeout(() => finish(false), FIT_VIEW_TIMEOUT_MS);
    globalThis.requestAnimationFrame(waitForFrame);
  });
}

function compactNode(node) {
  return {
    id: String(node.id),
    type: node.type,
    ...(node.isSubgraphNode?.() ? { subgraph_id: String(node.subgraph.id) } : {}),
    ...(node.title ? { title: node.title } : {}),
    pos: Array.from(node.pos),
    size: Array.from(node.size),
  };
}

function compactLink(graph, link) {
  const [id, sourceId, outputIndex, targetId, inputIndex, type] = Array.isArray(link)
    ? link
    : [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type];
  const source = graph.getNodeById(sourceId);
  const target = graph.getNodeById(targetId);
  return {
    id: String(id),
    from: {
      node: String(sourceId),
      output: source?.outputs?.[outputIndex]?.name
        ?? (String(sourceId) === String(graph.inputNode?.id) ? graph.inputs[outputIndex]?.name : undefined)
        ?? String(outputIndex),
    },
    to: {
      node: String(targetId),
      input: target?.inputs?.[inputIndex]?.name
        ?? (String(targetId) === String(graph.outputNode?.id) ? graph.outputs[inputIndex]?.name : undefined)
        ?? String(inputIndex),
    },
    ...(type == null ? {} : { type: clone(type) }),
  };
}

function compactGroup(group) {
  return {
    id: String(group.id),
    title: group.title,
    bounding: clone(group.bounding),
  };
}

function nodeRect(node) {
  return node.boundingRect ?? [node.pos[0], node.pos[1], node.size[0], node.size[1]];
}

function groupContainsNode(group, node) {
  const groupRect = group.boundingRect;
  const rect = nodeRect(node);
  const centerX = rect[0] + rect[2] * 0.5;
  const centerY = rect[1] + rect[3] * 0.5;
  return centerX >= groupRect[0]
    && centerX < groupRect[0] + groupRect[2]
    && centerY >= groupRect[1]
    && centerY < groupRect[1] + groupRect[3];
}

function namedWidgetValues(node, serializedNode) {
  if (serializedNode?.widgets_values_named) {
    return clone(serializedNode.widgets_values_named);
  }
  const indexedValues = serializedNode?.widgets_values ?? [];
  const values = {};
  for (const [index, widget] of (node.widgets ?? []).entries()) {
    if (widget.serialize === false) continue;
    const value = Object.hasOwn(indexedValues, index) ? indexedValues[index] : widget.value;
    values[widget.name] = clone(value ?? null);
  }
  return values;
}

function compactSlot(slot) {
  return {
    name: slot.name,
    ...(slot.label == null ? {} : { label: slot.label }),
    ...(slot.type == null ? {} : { type: clone(slot.type) }),
  };
}

function detailedNode(graph, node, serializedNode) {
  return {
    kind: "node",
    ...compactNode(node),
    widgets: namedWidgetValues(node, serializedNode),
    inputs: (node.inputs ?? []).map(compactSlot),
    outputs: (node.outputs ?? []).map(compactSlot),
    groups: (graph.groups ?? [])
      .filter((group) => groupContainsNode(group, node))
      .map((group) => ({ kind: "group", id: String(group.id) })),
  };
}

function detailedGroup(graph, group) {
  return {
    kind: "group",
    id: String(group.id),
    title: group.title,
    bounding: Array.from(group.boundingRect),
    color: group.color ?? null,
    flags: clone(group.flags ?? {}),
    contained_nodes: graph.nodes
      .filter((node) => groupContainsNode(group, node))
      .map((node) => ({ kind: "node", id: String(node.id) })),
  };
}

export function createLiveCanvas(app, LiteGraph, { pageId } = {}) {
  const canvas = app.canvas;
  const graph = canvas.graph;
  const rootGraph = graph.rootGraph ?? graph;
  const workflow = app.extensionManager.workflow.activeWorkflow;
  const identity = readLiveCanvasIdentity(app, pageId ?? "");

  return {
    identity: clone(identity),

    inspectCanvas({ refs } = {}) {
      const snapshot = graph.inputNode ? graph.asSerialisable() : graph.serialize();
      const inspectionContext = {
        page_id: identity.page_id,
        workflow_id: identity.workflow_id,
        workflow_path: identity.workflow_path,
        graph_id: identity.graph_id,
        root_graph_id: String(rootGraph.id),
        canvas_id: identity.canvas_id,
        revision: revisionOf(rootGraph === graph ? snapshot : rootGraph.serialize()),
        selection: canonicalSelection(canvas, graph),
        viewport: canonicalViewport(canvas),
        ...(graph.inputNode ? {
          subgraph: {
            name: graph.name,
            inputs: { node_id: String(graph.inputNode.id), slots: graph.inputs.map(compactSlot) },
            outputs: { node_id: String(graph.outputNode.id), slots: graph.outputs.map(compactSlot) },
          },
        } : {}),
      };
      const links = (snapshot.links ?? []).map((link) => compactLink(graph, link));
      if (refs !== undefined) {
        const serializedNodes = new Map(
          (snapshot.nodes ?? []).map((node) => [String(node.id), node]),
        );
        const nodeIds = new Set(
          refs
            .filter((reference) => reference.kind === "node")
            .map((reference) => String(reference.id)),
        );
        return {
          ...inspectionContext,
          items: refs.map((reference) => {
            if (reference.kind === "group") {
              return detailedGroup(graph, resolveGroup(graph, reference.id, {}));
            }
            const node = resolveNode(graph, reference.id, {});
            return detailedNode(graph, node, serializedNodes.get(String(node.id)));
          }),
          links: links.filter(({ from, to }) => nodeIds.has(from.node) || nodeIds.has(to.node)),
        };
      }
      return {
        ...inspectionContext,
        nodes: graph.nodes.map(compactNode),
        links,
        groups: (snapshot.groups ?? []).map(compactGroup),
      };
    },

    async presentCanvas(presentation) {
      if (
        app.canvas !== canvas
        || canvas.graph !== graph
        || app.extensionManager.workflow.activeWorkflow !== workflow
      ) {
        throw bridgeError("canvas_changed", "The active ComfyUI canvas changed; inspect it again");
      }
      if (presentation?.canvas_id !== identity.canvas_id) {
        throw bridgeError("canvas_mismatch", "The presentation targets a different ComfyUI canvas", {
          expected: identity.canvas_id,
          received: presentation?.canvas_id,
        });
      }
      if (!Array.isArray(presentation.refs)) {
        throw bridgeError("invalid_presentation", "Canvas presentation refs must be an array");
      }
      if (presentation.selection !== "replace" && presentation.selection !== "add") {
        throw bridgeError(
          "invalid_presentation",
          "Canvas presentation selection must be replace or add",
        );
      }
      if (typeof presentation.fit_view !== "boolean") {
        throw bridgeError("invalid_presentation", "Canvas presentation fit_view must be a boolean");
      }

      if (presentation.graph_id !== undefined && presentation.graph_id !== String(graph.id)) {
        const targetGraph = presentation.graph_id === String(rootGraph.id)
          ? rootGraph
          : rootGraph.subgraphs?.get(presentation.graph_id);
        if (!targetGraph) {
          throw bridgeError("graph_not_found", `Graph does not exist: ${presentation.graph_id}`);
        }
        // Resolve every target ref before changing the visible graph.
        for (const reference of presentation.refs) {
          if (reference?.kind === "group") resolveGroup(targetGraph, reference.id, {});
          else if (reference?.kind === "node") resolveNode(targetGraph, reference.id, {});
          else throw bridgeError("invalid_presentation", "Canvas presentation refs must target nodes or groups");
        }
        const host = graph.nodes.find((node) => node.isSubgraphNode?.() && node.subgraph === targetGraph);
        if (host) canvas.openSubgraph(targetGraph, host);
        else {
          canvas.subgraph = targetGraph === rootGraph ? undefined : targetGraph;
          canvas.setGraph(targetGraph);
        }
        if (canvas.graph !== targetGraph) {
          throw bridgeError("navigation_rejected", "ComfyUI rejected the requested graph navigation");
        }
        canvas.ds.computeVisibleArea(canvas.viewport);
        const targetCanvas = createLiveCanvas(app, LiteGraph, { pageId });
        return targetCanvas.presentCanvas({
          ...presentation,
          canvas_id: targetCanvas.identity.canvas_id,
        });
      }

      const items = presentation.refs.map((reference, index) => {
        if (reference?.kind === "group") return resolveGroup(graph, reference.id, {});
        if (reference?.kind === "node") return resolveNode(graph, reference.id, {});
        throw bridgeError("invalid_presentation", "Canvas presentation refs must target nodes or groups", {
          reference_index: index,
        });
      });

      const groups = graph.groups ?? [];
      const groupOrder = items.some((item) => groups.includes(item))
        ? new Map(groups.map((group, index) => [group, index]))
        : null;
      try {
        if (presentation.selection === "replace") canvas.deselectAll();
        if (items.length > 0) canvas.selectItems(items, true);
      } finally {
        if (
          groupOrder !== null
          && groups.some((group, index) => groupOrder.get(group) !== index)
        ) {
          groups.sort(
            (left, right) => (groupOrder.get(left) ?? groupOrder.size)
              - (groupOrder.get(right) ?? groupOrder.size),
          );
        }
      }
      if (presentation.fit_view) {
        const bounds = fitViewBounds(canvas);
        canvas.fitViewToSelectionAnimated({ duration: FIT_VIEW_ANIMATION_MS });
        const animationCompleted = await waitForFitViewAnimation();
        if (!animationCompleted && bounds !== null) {
          canvas.ds.fitToBounds(bounds);
          canvas.setDirty(true, true);
        }
        canvas.ds.computeVisibleArea(canvas.viewport);
      }
      if (
        app.canvas !== canvas
        || canvas.graph !== graph
        || app.extensionManager.workflow.activeWorkflow !== workflow
      ) {
        throw bridgeError("canvas_changed", "The active ComfyUI canvas changed; inspect it again");
      }

      return {
        canvas_id: identity.canvas_id,
        selection: canonicalSelection(canvas, graph),
        viewport: canonicalViewport(canvas),
      };
    },

    async applyCanvasPatch(patch) {
      if (
        app.canvas !== canvas
        || canvas.graph !== graph
        || app.extensionManager.workflow.activeWorkflow !== workflow
      ) {
        throw bridgeError("canvas_changed", "The active ComfyUI canvas changed; inspect it again");
      }
      if (!Array.isArray(patch?.operations)) {
        throw bridgeError("invalid_patch", "Canvas patch operations must be an array");
      }
      const { operations } = patch;
      if (operations.length === 0) {
        throw bridgeError("invalid_patch", "A canvas patch must contain at least one operation");
      }
      for (const [index, operation] of operations.entries()) {
        if (
          operation === null
          || Array.isArray(operation)
          || typeof operation !== "object"
          || typeof operation.op !== "string"
          || operation.op.length === 0
        ) {
          throw bridgeError(
            "invalid_patch",
            "Each canvas patch operation must have a non-empty string op",
            { operation_index: index },
          );
        }
      }
      if (patch.canvas_id !== identity.canvas_id) {
        throw bridgeError("canvas_mismatch", "The patch targets a different ComfyUI canvas", {
          expected: identity.canvas_id,
          received: patch.canvas_id,
        });
      }

      const snapshot = clone(rootGraph.serialize());
      const currentRevision = revisionOf(snapshot);
      if (patch.base_revision !== currentRevision) {
        throw bridgeError("stale_revision", "The ComfyUI canvas changed; inspect it again", {
          expected: currentRevision,
          received: patch.base_revision,
        });
      }

      const { plan, preparedNodes, preparedGroups } = preflightOperations(
        graph,
        LiteGraph,
        operations,
      );

      const changeTracker = workflow.changeTracker;
      const trackerDepth = Number.isInteger(changeTracker?.changeCount)
        ? changeTracker.changeCount
        : null;
      const trackerIsActive = () => (
        app.extensionManager.workflow.activeWorkflow === workflow
        && workflow.changeTracker === changeTracker
      );
      const targetIsCurrent = () => (
        app.canvas === canvas
        && canvas.graph === graph
        && trackerIsActive()
      );
      let changeError = null;
      let restored = false;
      let canvasTransactionOpened = false;
      const rememberError = (error) => {
        changeError ??= error;
      };
      const restoreGraph = () => {
        if (restored || !targetIsCurrent()) return;
        try {
          rootGraph.configure(clone(snapshot));
          if (rootGraph !== graph) {
            const restoredGraph = rootGraph.subgraphs.get(graph.id);
            canvas.subgraph = restoredGraph;
            canvas.setGraph(restoredGraph);
          }
          restored = true;
        } catch (error) {
          rememberError(error);
        }
      };
      const recoverChangeTracker = () => {
        if (trackerDepth === null || changeTracker.changeCount <= trackerDepth) return;
        if (!trackerIsActive()) {
          changeTracker.changeCount = trackerDepth;
          return;
        }
        try {
          changeTracker.afterChange();
        } catch (error) {
          rememberError(error);
        }
      };
      const closeCanvasTransaction = () => {
        if (!canvasTransactionOpened) return;
        if (trackerIsActive()) {
          try {
            canvas.emitAfterChange();
          } catch (error) {
            rememberError(error);
            restoreGraph();
          }
        }
        recoverChangeTracker();
        canvasTransactionOpened = false;
      };

      // Keep the native transaction synchronous. Browser input, workflow
      // navigation, and the next queued MCP command cannot interleave with it.
      canvasTransactionOpened = true;
      try {
        canvas.emitBeforeChange();
      } catch (error) {
        rememberError(error);
        recoverChangeTracker();
        throw changeError;
      }
      try {
        graph.beforeChange();
      } catch (error) {
        rememberError(error);
        closeCanvasTransaction();
        throw changeError;
      }

      let applied;
      try {
        applied = applyOperations(
          canvas,
          graph,
          LiteGraph,
          plan,
          preparedNodes,
          preparedGroups,
        );
      } catch (error) {
        rememberError(error);
        restoreGraph();
      }
      try {
        graph.afterChange();
      } catch (error) {
        rememberError(error);
        restoreGraph();
      }

      let appliedSnapshot;
      if (changeError === null) {
        if (!trackerIsActive()) {
          rememberError(bridgeError("canvas_changed", "The active ComfyUI canvas changed; inspect it again"));
        } else {
          try {
            appliedSnapshot = rootGraph.serialize();
          } catch (error) {
            rememberError(error);
            restoreGraph();
          }
        }
      }

      closeCanvasTransaction();
      if (changeError !== null) throw changeError;

      return {
        canvas_id: identity.canvas_id,
        revision: revisionOf(appliedSnapshot),
        id_map: applied.idMap,
        group_id_map: applied.groupIdMap,
        changed_node_ids: applied.changedNodeIds,
        changed_group_ids: applied.changedGroupIds,
        undoable: true,
      };
    },
  };
}
