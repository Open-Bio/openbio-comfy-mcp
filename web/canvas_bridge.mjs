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

function revisionOf(snapshot) {
  const text = JSON.stringify({
    nodes: snapshot.nodes ?? [],
    links: snapshot.links ?? [],
    groups: snapshot.groups ?? [],
    reroutes: snapshot.reroutes ?? [],
    legacy_reroutes: snapshot.extra?.reroutes ?? [],
  });
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
      context.preparedGroups[operation.temp_ref] = new context.LiteGraph.LGraphGroup(operation.title);
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
      plannedGroup(context, operation.group_id);
    },
    apply(context, operation) {
      const group = resolveGroup(context.graph, operation.group_id, context.groupIdMap);
      updateGroup(group, operation);
      context.changedGroupIds.add(String(group.id));
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
      const source = plannedNode(context, operation.source);
      const target = plannedNode(context, operation.target);
      const output = outputSlot(source, operation.output_name);
      const input = inputSlot(target, operation.input_name);
      if (source === target || context.LiteGraph.isValidConnection?.(output.type, input.type) === false) {
        throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
      }
    },
    apply(context, operation) {
      const source = resolveNode(context.graph, operation.source, context.idMap);
      const target = resolveNode(context.graph, operation.target, context.idMap);
      if (!source.connect(operation.output_name, target, operation.input_name)) {
        throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
      }
      context.changedNodeIds.add(String(source.id));
      context.changedNodeIds.add(String(target.id));
    },
  }],
  ["disconnect", {
    preflight(context, operation) {
      inputSlot(plannedNode(context, operation.target), operation.input_name);
    },
    apply(context, operation) {
      const target = resolveNode(context.graph, operation.target, context.idMap);
      inputSlot(target, operation.input_name);
      context.changedNodeIds.add(String(target.id));
      if (target.disconnectInput(operation.input_name) === false) {
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
  const context = {
    graph,
    LiteGraph,
    preparedNodes: {},
    preparedGroups: {},
    removedNodes: new Set(),
    removedGroups: new Set(),
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

function applyOperations(canvas, graph, plan, preparedNodes, preparedGroups) {
  const context = {
    canvas,
    graph,
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

function compactNode(node) {
  return {
    id: String(node.id),
    type: node.type,
    ...(node.title ? { title: node.title } : {}),
    pos: Array.from(node.pos),
    size: Array.from(node.size),
  };
}

function compactLink(graph, link) {
  const [id, sourceId, outputIndex, targetId, inputIndex, type] = link;
  const source = graph.getNodeById(sourceId);
  const target = graph.getNodeById(targetId);
  return {
    id: String(id),
    from: {
      node: String(sourceId),
      output: source?.outputs?.[outputIndex]?.name ?? String(outputIndex),
    },
    to: {
      node: String(targetId),
      input: target?.inputs?.[inputIndex]?.name ?? String(inputIndex),
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
  const workflow = app.extensionManager.workflow.activeWorkflow;
  const identity = readLiveCanvasIdentity(app, pageId ?? "");

  return {
    identity: clone(identity),

    inspectCanvas({ refs } = {}) {
      const snapshot = graph.serialize();
      const inspectionContext = {
        page_id: identity.page_id,
        workflow_id: identity.workflow_id,
        workflow_path: identity.workflow_path,
        graph_id: identity.graph_id,
        canvas_id: identity.canvas_id,
        revision: revisionOf(snapshot),
        selection: canonicalSelection(canvas, graph),
        viewport: {
          scale: canvas.ds.state.scale,
          offset: Array.from(canvas.ds.state.offset),
          visible_area: Array.from(canvas.ds.visible_area),
        },
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

      const snapshot = graph.serialize();
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
          graph.configure(clone(snapshot));
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
            appliedSnapshot = graph.serialize();
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
