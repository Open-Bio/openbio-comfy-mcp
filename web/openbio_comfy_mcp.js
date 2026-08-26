import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

import { registerLiveCanvasWebExtension } from "./extension.mjs";

registerLiveCanvasWebExtension({
  app,
  api,
  LiteGraph: globalThis.LiteGraph,
});
