import {
  CanvasBridgeError,
  createLiveCanvas,
  readLiveCanvasIdentity,
} from "./canvas_bridge.mjs";

export const EXTENSION_NAME = "OpenBio.ComfyMCP";
export const COMMAND_EVENT = "openbio-comfy-mcp:command";
export const SESSION_PATH = "/openbio-comfy-mcp/session";
export const REPLY_PATH = "/openbio-comfy-mcp/reply";
export const HEARTBEAT_MS = 5_000;

function postJson(api, path, body, method = "POST") {
  return api.fetchApi(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function serializedError(error) {
  return {
    code: error instanceof CanvasBridgeError ? error.code : "canvas_command_failed",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof CanvasBridgeError && error.details !== undefined
      ? { details: error.details }
      : {}),
  };
}

function newPageId() {
  return globalThis.crypto.randomUUID();
}

export function createLiveCanvasWebExtension({
  app,
  api,
  LiteGraph,
  pageId = newPageId(),
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  heartbeatMs = HEARTBEAT_MS,
}) {
  let heartbeatId;
  let unsubscribeWorkflow;
  let registeredWorkflowId;
  let commandQueue = Promise.resolve();
  let wasFocused = false;
  let lastFocusedAt = null;

  function isFocused() {
    return documentRef.visibilityState !== "hidden" && documentRef.hasFocus();
  }

  function handleFocusChange() {
    const focused = isFocused();
    if (focused && !wasFocused) lastFocusedAt = Date.now();
    wasFocused = focused;
    return registerSession();
  }

  async function registerSession() {
    if (!api.clientId) return;
    const identity = readLiveCanvasIdentity(app, pageId);
    registeredWorkflowId = identity.workflow_id;
    await postJson(api, SESSION_PATH, {
      page_id: pageId,
      client_id: api.clientId,
      workflow_id: identity.workflow_id,
      canvas_id: identity.canvas_id,
      focused: isFocused(),
      last_focused_at: lastFocusedAt,
      href: windowRef.location.href,
    });
  }

  async function handleWorkflowChange() {
    const { workflow_id: workflowId } = readLiveCanvasIdentity(app, pageId);
    if (workflowId === registeredWorkflowId) return;
    await registerSession();
  }

  async function reply(requestId, body) {
    await postJson(api, REPLY_PATH, {
      page_id: pageId,
      request_id: requestId,
      ...body,
    });
  }

  async function handleCommand(event) {
    const message = event.detail;
    try {
      const liveCanvas = createLiveCanvas(app, LiteGraph, { pageId });
      if (message.page_id !== pageId) {
        throw new CanvasBridgeError("page_mismatch", "The command targets a different ComfyUI page");
      }
      if (
        message.canvas_id !== liveCanvas.identity.canvas_id
        || message.workflow_id !== liveCanvas.identity.workflow_id
      ) {
        throw new CanvasBridgeError("canvas_mismatch", "The command targets a different ComfyUI canvas", {
          canvas_id: liveCanvas.identity.canvas_id,
          workflow_id: liveCanvas.identity.workflow_id,
        });
      }

      let result;
      if (message.command === "inspect_canvas") {
        result = liveCanvas.inspectCanvas(message.arguments);
      } else if (message.command === "apply_canvas_patch") {
        result = await liveCanvas.applyCanvasPatch({
          ...message.arguments,
          canvas_id: message.canvas_id,
        });
      } else if (message.command === "present_canvas") {
        result = await liveCanvas.presentCanvas({
          ...message.arguments,
          canvas_id: message.canvas_id,
        });
      } else {
        throw new CanvasBridgeError(
          "unsupported_command",
          `Unsupported canvas command: ${message.command}`,
        );
      }
      if (readLiveCanvasIdentity(app, pageId).canvas_id !== liveCanvas.identity.canvas_id) {
        // Make the returned canvas_id routable before the client sends its next command.
        await registerSession();
      }
      await reply(message.request_id, { ok: true, result });
    } catch (error) {
      await reply(message.request_id, { ok: false, error: serializedError(error) });
    }
  }

  function enqueueCommand(event) {
    const pending = commandQueue.then(() => handleCommand(event));
    commandQueue = pending.catch(() => {});
    return pending;
  }

  function destroy() {
    if (heartbeatId !== undefined) clearIntervalFn(heartbeatId);
    unsubscribeWorkflow?.();
    api.removeCustomEventListener(COMMAND_EVENT, enqueueCommand);
    api.removeEventListener("reconnected", registerSession);
    app.canvas.canvas.removeEventListener("litegraph:set-graph", registerSession);
    windowRef.removeEventListener("focus", handleFocusChange);
    windowRef.removeEventListener("blur", handleFocusChange);
    documentRef.removeEventListener("visibilitychange", handleFocusChange);
  }

  return {
    name: EXTENSION_NAME,
    async setup() {
      api.addCustomEventListener(COMMAND_EVENT, enqueueCommand);
      api.addEventListener("reconnected", registerSession);
      app.canvas.canvas.addEventListener("litegraph:set-graph", registerSession);
      unsubscribeWorkflow = app.extensionManager.workflow.$subscribe(handleWorkflowChange, {
        detached: true,
      });
      windowRef.addEventListener("focus", handleFocusChange);
      windowRef.addEventListener("blur", handleFocusChange);
      documentRef.addEventListener("visibilitychange", handleFocusChange);
      heartbeatId = setIntervalFn(registerSession, heartbeatMs);
      await handleFocusChange();
    },
    destroy,
  };
}

export function registerLiveCanvasWebExtension(dependencies) {
  const extension = createLiveCanvasWebExtension(dependencies);
  dependencies.app.registerExtension(extension);
  return extension;
}
