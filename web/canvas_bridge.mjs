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

function applyOperations(canvas, graph, operations, preparedNodes) {
  const idMap = {};
  const changedNodeIds = new Set();
  let unpositionedNodes = 0;
  for (const operation of operations) {
    switch (operation.op) {
      case "add_node": {
        const node = preparedNodes[operation.temp_ref];
        if (operation.pos) {
          node.pos = clone(operation.pos);
        } else {
          const area = canvas.ds.visible_area ?? canvas.visible_area;
          node.pos = [
            area[0] + area[2] / 2 - node.size[0] / 2 + unpositionedNodes * 40,
            area[1] + area[3] / 2 - node.size[1] / 2,
          ];
          unpositionedNodes += 1;
        }
        graph.add(node);
        idMap[operation.temp_ref] = String(node.id);
        changedNodeIds.add(String(node.id));
        break;
      }
      case "remove_node": {
        const node = resolveNode(graph, operation.node_id, idMap);
        assertNodeRemovable(node);
        changedNodeIds.add(String(node.id));
        graph.remove(node);
        if (graph.getNodeById(node.id)) {
          throw bridgeError("removal_rejected", `ComfyUI rejected removal of node: ${node.id}`, {
            node_id: String(node.id),
          });
        }
        break;
      }
      case "set_input": {
        const node = resolveNode(graph, operation.node_id, idMap);
        changedNodeIds.add(String(node.id));
        setInput(node, operation.input_name, operation.value);
        break;
      }
      case "connect": {
        const source = resolveNode(graph, operation.source, idMap);
        const target = resolveNode(graph, operation.target, idMap);
        if (!source.connect(operation.output_name, target, operation.input_name)) {
          throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
        }
        changedNodeIds.add(String(source.id));
        changedNodeIds.add(String(target.id));
        break;
      }
      case "disconnect": {
        const target = resolveNode(graph, operation.target, idMap);
        inputSlot(target, operation.input_name);
        changedNodeIds.add(String(target.id));
        if (target.disconnectInput(operation.input_name) === false) {
          throw bridgeError("connection_rejected", "ComfyUI rejected the requested disconnection");
        }
        break;
      }
      case "move_node": {
        const node = resolveNode(graph, operation.node_id, idMap);
        changedNodeIds.add(String(node.id));
        node.pos = clone(operation.pos);
        break;
      }
      default:
        throw bridgeError("unsupported_operation", `Unsupported canvas operation: ${operation.op}`, {
          operation: operation.op,
        });
    }
  }
  graph.setDirtyCanvas(true, true);
  return { idMap, changedNodeIds: [...changedNodeIds].sort() };
}

function preflightOperations(graph, LiteGraph, operations) {
  const preparedNodes = {};
  const removedNodes = new Set();

  function plannedNode(reference) {
    const node = Object.hasOwn(preparedNodes, reference)
      ? preparedNodes[reference]
      : graph.getNodeById(reference);
    if (!node || removedNodes.has(node)) {
      throw bridgeError("node_not_found", `Node does not exist: ${reference}`, { reference });
    }
    return node;
  }

  for (const operation of operations) {
    switch (operation.op) {
      case "add_node": {
        if (Object.hasOwn(preparedNodes, operation.temp_ref)) {
          throw bridgeError("duplicate_temp_ref", `Duplicate temp_ref: ${operation.temp_ref}`);
        }
        const node = LiteGraph.createNode(operation.class_type);
        if (!node) {
          throw bridgeError("node_type_not_found", `Node type is not installed: ${operation.class_type}`, {
            class_type: operation.class_type,
          });
        }
        preparedNodes[operation.temp_ref] = node;
        break;
      }
      case "remove_node": {
        const node = plannedNode(operation.node_id);
        assertNodeRemovable(node);
        removedNodes.add(node);
        break;
      }
      case "set_input":
        inputWidget(plannedNode(operation.node_id), operation.input_name);
        break;
      case "connect": {
        const source = plannedNode(operation.source);
        const target = plannedNode(operation.target);
        const output = outputSlot(source, operation.output_name);
        const input = inputSlot(target, operation.input_name);
        if (source === target || LiteGraph.isValidConnection?.(output.type, input.type) === false) {
          throw bridgeError("connection_rejected", "ComfyUI rejected the requested connection");
        }
        break;
      }
      case "disconnect":
        inputSlot(plannedNode(operation.target), operation.input_name);
        break;
      case "move_node":
        plannedNode(operation.node_id);
        break;
      default:
        throw bridgeError("unsupported_operation", `Unsupported canvas operation: ${operation.op}`, {
          operation: operation.op,
        });
    }
  }
  return preparedNodes;
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

export function createLiveCanvas(app, LiteGraph, { pageId } = {}) {
  const canvas = app.canvas;
  const graph = canvas.graph;
  const workflow = app.extensionManager.workflow.activeWorkflow;
  const identity = readLiveCanvasIdentity(app, pageId ?? "");

  return {
    identity: clone(identity),

    inspectCanvas() {
      const snapshot = graph.serialize();
      return {
        page_id: identity.page_id,
        workflow_id: identity.workflow_id,
        workflow_path: identity.workflow_path,
        graph_id: identity.graph_id,
        canvas_id: identity.canvas_id,
        revision: revisionOf(snapshot),
        nodes: clone(snapshot.nodes ?? []),
        links: clone(snapshot.links ?? []),
        selection: canonicalSelection(canvas, graph),
        viewport: {
          scale: canvas.ds.state.scale,
          offset: Array.from(canvas.ds.state.offset),
          visible_area: Array.from(canvas.ds.visible_area),
        },
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

      const preparedNodes = preflightOperations(graph, LiteGraph, patch.operations ?? []);

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
        applied = applyOperations(canvas, graph, patch.operations ?? [], preparedNodes);
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
        changed_node_ids: applied.changedNodeIds,
        undoable: true,
      };
    },
  };
}
