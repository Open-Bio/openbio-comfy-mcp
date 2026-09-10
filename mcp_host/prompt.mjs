import { McpHostError, unavailableError } from "./errors.mjs";

export const DEFAULT_WAIT_SECONDS = 120;
export const MAX_WAIT_SECONDS = 600;
export const POLL_MS = 500;
const TERMINAL_STATUSES = new Set(["completed", "error"]);

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function viewUrl(baseUrl, output) {
  const origin = baseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder ?? "",
    type: output.type ?? "output",
  });
  return `${origin}/view?${params}`;
}

function withViewUrls(baseUrl, value) {
  return {
    ...value,
    outputs: (value.outputs ?? []).map((output) => ({
      ...output,
      view_url: viewUrl(baseUrl, output),
    })),
  };
}

export async function inspectPrompt({ prompt_id: promptId }, {
  baseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof promptId !== "string" || !promptId) {
    throw new McpHostError("INVALID_REQUEST", "inspect_prompt requires prompt_id.");
  }
  const origin = baseUrl.replace(/\/$/, "");
  const url = `${origin}/openbio-comfy-mcp/prompt/${encodeURIComponent(promptId)}`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw unavailableError(origin, error);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new McpHostError(
      "COMFYUI_INVALID_RESPONSE",
      "ComfyUI returned invalid JSON for prompt status.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!response.ok || body?.error) {
    throw new McpHostError(
      body?.error?.code ?? "COMFYUI_REQUEST_FAILED",
      body?.error?.message ?? `ComfyUI returned HTTP ${response.status} for prompt status.`,
      body?.error?.details,
    );
  }
  const value = body.result ?? body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpHostError(
      "COMFYUI_INVALID_RESPONSE",
      "ComfyUI returned an invalid prompt status.",
    );
  }
  return withViewUrls(origin, {
    prompt_id: value.prompt_id ?? promptId,
    status: value.status ?? "not_found",
    outputs: Array.isArray(value.outputs) ? value.outputs : [],
    ...(value.error && typeof value.error === "object" && !Array.isArray(value.error)
      ? { error: value.error }
      : {}),
  });
}

export async function waitForPrompt({
  prompt_id: promptId,
  timeout_seconds: timeoutSeconds = DEFAULT_WAIT_SECONDS,
} = {}, {
  baseUrl,
  fetchImpl = globalThis.fetch,
  sleep = sleepMs,
} = {}) {
  if (typeof promptId !== "string" || !promptId) {
    throw new McpHostError("INVALID_REQUEST", "wait_for_prompt requires prompt_id.");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
    throw new McpHostError("INVALID_REQUEST", "timeout_seconds must be at least 1.");
  }
  const timeoutMs = Math.min(timeoutSeconds, MAX_WAIT_SECONDS) * 1000;
  let elapsed = 0;
  let value;
  while (true) {
    value = await inspectPrompt({ prompt_id: promptId }, { baseUrl, fetchImpl });
    if (TERMINAL_STATUSES.has(value.status)) return value;
    if (elapsed >= timeoutMs) {
      if (value.status === "not_found") return value;
      throw new McpHostError(
        "PROMPT_TIMEOUT",
        "Timed out waiting for the queued prompt to finish.",
        { prompt_id: promptId, status: value.status },
      );
    }
    await sleep(POLL_MS);
    elapsed += POLL_MS;
  }
}
