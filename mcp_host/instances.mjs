import { readFile, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { McpHostError } from "./errors.mjs";

const DEFAULT_URL = "http://127.0.0.1:8188";
const REGISTRATION_TTL_SECONDS = 30;
const CANVAS_PREFIX = "openbio-canvas:";

function scopedCanvasId(instance, canvasId) {
  if (!instance.expected_instance_id) return canvasId;
  const identity = [instance.instance_id, instance.expected_instance_id, canvasId];
  return CANVAS_PREFIX + Buffer.from(JSON.stringify(identity)).toString("base64url");
}

function canvasRoute(canvasId) {
  if (typeof canvasId !== "string" || !canvasId.startsWith(CANVAS_PREFIX)) return null;
  try {
    const identity = JSON.parse(Buffer.from(canvasId.slice(CANVAS_PREFIX.length), "base64url").toString());
    if (!Array.isArray(identity) || identity.length !== 3
      || identity.some((part) => typeof part !== "string" || !part)) throw new Error("Invalid identity");
    const [instance_id, expected_instance_id, native_canvas_id] = identity;
    return { instance_id, expected_instance_id, native_canvas_id };
  } catch {
    throw new McpHostError("INVALID_CANVAS_ID", "Use the canvas_id returned by list_instances or inspect_canvas.");
  }
}

function isLocalHostname(hostname) {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (host === "localhost") return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10
      || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254);
  }
  if (version === 6) {
    const ip = host.toLowerCase();
    if (ip === "::1") return true;
    const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : "";
    if (mapped && isIP(mapped) === 4) return isLocalHostname(mapped);
    return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
  }
  return false;
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
      && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function lastFocusedAt(instance) {
  const times = instance.canvases.map((canvas) => canvas.last_focused_at)
    .filter((time) => Number.isFinite(time) && time >= 0);
  return times.length ? Math.max(...times) : null;
}

function lastFocusedCanvas(instance) {
  const latest = lastFocusedAt(instance);
  if (latest === null) return undefined;
  const canvases = instance.canvases.filter((canvas) => canvas.last_focused_at === latest);
  return canvases.length === 1 ? canvases[0].canvas_id : undefined;
}

function publicInstance(instance) {
  return {
    instance_id: instance.instance_id,
    base_url: instance.base_url,
    ...(instance.pid === undefined ? {} : { pid: instance.pid }),
    status: instance.status,
    last_focused_at: lastFocusedAt(instance),
    canvases: instance.canvases.map((canvas) => ({
      ...canvas, canvas_id: scopedCanvasId(instance, canvas.canvas_id),
    })),
  };
}

export function createInstanceRouter({
  baseUrl,
  registryDir = process.env.OPENBIO_COMFY_REGISTRY_DIR
    ?? path.join(homedir(), ".openbio-comfy-mcp", "instances"),
  fetchImpl = globalThis.fetch,
} = {}) {
  const configured = baseUrl === undefined ? null : {
    instance_id: "configured", base_url: baseUrl,
  };
  const fallback = { instance_id: "default", base_url: DEFAULT_URL };

  async function registrations() {
    let files;
    try {
      files = await readdir(registryDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new McpHostError("INSTANCE_DISCOVERY_FAILED", "Cannot read the local ComfyUI instance directory.", {
        directory: registryDir, cause: error.message,
      });
    }
    const records = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
      let record;
      try {
        record = JSON.parse(await readFile(path.join(registryDir, file), "utf8"));
      } catch (error) {
        // Registration may disappear during shutdown; incomplete records are not instances.
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw new McpHostError("INSTANCE_DISCOVERY_FAILED", "Cannot read a local ComfyUI registration.", {
          file, cause: error.message,
        });
      }
      if (!record || typeof record.instance_id !== "string" || !record.instance_id
        || !isLocalUrl(record.base_url) || !Number.isFinite(record.updated_at)
        || Date.now() / 1000 - record.updated_at > REGISTRATION_TTL_SECONDS) return null;
      return {
        instance_id: record.instance_id,
        base_url: record.base_url.replace(/\/$/, ""),
        pid: record.pid,
        expected_instance_id: record.instance_id,
      };
    }));
    return records.filter(Boolean).sort((left, right) => left.base_url.localeCompare(right.base_url));
  }

  async function probe(instance) {
    try {
      const response = await fetchImpl(`${instance.base_url.replace(/\/$/, "")}/openbio-comfy-mcp/health`, {
        signal: AbortSignal.timeout(1_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Health check failed");
      const health = await response.json();
      if (health?.ok !== true
        || (instance.expected_instance_id && health.instance_id !== instance.expected_instance_id)) {
        throw new Error("Instance identity changed");
      }
      return {
        ...instance,
        ...(typeof health.instance_id === "string" && health.instance_id
          ? { expected_instance_id: health.instance_id } : {}),
        status: "online",
        canvases: Array.isArray(health.canvases) ? health.canvases : [],
      };
    } catch {
      return { ...instance, status: "unavailable", canvases: [] };
    }
  }

  async function availableInstances() {
    const records = configured ? [configured] : await registrations();
    return Promise.all((records.length ? records : [fallback]).map(probe));
  }

  async function requireAvailable(instance) {
    // Explicit URLs and the legacy fallback work with older plugins without instance metadata.
    if (!instance.expected_instance_id) return instance;
    const checked = await probe(instance);
    if (checked.status !== "online") {
      throw new McpHostError("INSTANCE_UNAVAILABLE", "The selected ComfyUI instance is unavailable or has restarted.", {
        instance_id: instance.instance_id, base_url: instance.base_url,
      });
    }
    return checked;
  }

  return {
    async listInstances() {
      return { instances: (await availableInstances()).map(publicInstance) };
    },

    async resolve({ instance_id: instanceId, canvas_id: canvasId } = {}) {
      const route = canvasRoute(canvasId);
      if (route) {
        if (instanceId !== undefined && instanceId !== route.instance_id) {
          throw new McpHostError("INSTANCE_MISMATCH", "The canvas belongs to a different ComfyUI instance.");
        }
        const records = configured ? [configured] : [fallback, ...await registrations()];
        const target = records.find((instance) => instance.instance_id === route.instance_id);
        if (!target) {
          throw new McpHostError("INSTANCE_UNAVAILABLE", "The canvas's ComfyUI process is no longer registered; inspect a current instance.", {
            instance_id: route.instance_id,
          });
        }
        if (target.expected_instance_id && target.expected_instance_id !== route.expected_instance_id) {
          throw new McpHostError("INSTANCE_MISMATCH", "The canvas identity does not match the registered ComfyUI process.");
        }
        const checked = await requireAvailable({ ...target, expected_instance_id: route.expected_instance_id });
        return { ...checked, native_canvas_id: route.native_canvas_id };
      }

      if (configured) {
        if (instanceId !== undefined && instanceId !== configured.instance_id) {
          throw new McpHostError("INSTANCE_NOT_FOUND", "The requested ComfyUI instance is not configured.");
        }
        return { ...configured, native_canvas_id: canvasId };
      }
      const records = await registrations();
      if (!records.length && (instanceId === undefined || instanceId === fallback.instance_id)) {
        return { ...fallback, native_canvas_id: canvasId };
      }
      if (instanceId !== undefined) {
        const target = records.find((instance) => instance.instance_id === instanceId);
        if (!target) {
          throw new McpHostError("INSTANCE_NOT_FOUND", "The requested ComfyUI instance is not registered.", {
            instance_id: instanceId,
          });
        }
        const checked = await requireAvailable(target);
        if (canvasId !== undefined && !checked.canvases.some((canvas) => canvas.canvas_id === canvasId)) {
          throw new McpHostError("INSTANCE_MISMATCH", "The selected instance does not have this active canvas.");
        }
        return { ...checked, native_canvas_id: canvasId ?? lastFocusedCanvas(checked) };
      }

      const instances = await Promise.all(records.map(probe));
      const matches = instances.filter((instance) => instance.status === "online"
        && (canvasId === undefined || instance.canvases.some((canvas) => canvas.canvas_id === canvasId)));
      if (matches.length === 1) {
        return { ...matches[0], native_canvas_id: canvasId ?? lastFocusedCanvas(matches[0]) };
      }
      if (matches.length > 1) {
        if (canvasId === undefined) {
          const times = matches.map(lastFocusedAt).filter((time) => time !== null);
          if (times.length) {
            const latest = Math.max(...times);
            const recent = matches.filter((instance) => lastFocusedAt(instance) === latest);
            if (recent.length === 1) {
              return { ...recent[0], native_canvas_id: lastFocusedCanvas(recent[0]) };
            }
          }
        }
        throw new McpHostError("AMBIGUOUS_INSTANCE", "More than one ComfyUI instance matches without a unique last focus; use list_instances and choose an instance_id.", {
          instance_ids: matches.map((instance) => instance.instance_id),
        });
      }
      if (canvasId !== undefined) {
        throw new McpHostError("NO_LIVE_CANVAS", "No registered ComfyUI instance has this active canvas.", {
          canvas_id: canvasId,
        });
      }
      throw new McpHostError("INSTANCE_UNAVAILABLE", "No registered ComfyUI instance is available.");
    },

    bindResult(instance, result, processId) {
      if (instance.expected_instance_id && processId && processId !== instance.expected_instance_id) {
        throw new McpHostError("INSTANCE_MISMATCH", "The reply came from a different ComfyUI process.");
      }
      const target = processId ? { ...instance, expected_instance_id: processId } : instance;
      return {
        ...result,
        ...(typeof result.canvas_id === "string" ? { canvas_id: scopedCanvasId(target, result.canvas_id) } : {}),
        instance_id: instance.instance_id,
      };
    },
  };
}
