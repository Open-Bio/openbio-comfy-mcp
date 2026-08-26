export class McpHostError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "McpHostError";
    this.code = code;
    this.details = details;
  }
}

export function unavailableError(baseUrl, cause) {
  return new McpHostError(
    "COMFYUI_UNAVAILABLE",
    `Could not reach ComfyUI at ${baseUrl}.`,
    { cause: cause instanceof Error ? cause.message : String(cause) },
  );
}
