import { McpHostError, unavailableError } from "./errors.mjs";

function inputRows(group, required) {
  return Object.entries(group ?? {}).map(([name, definition]) => ({
    name,
    type: Array.isArray(definition) ? definition[0] : definition,
    required,
  }));
}

function outputRows(schema) {
  return (schema.output ?? []).map((type, index) => ({
    index,
    name: schema.output_name?.[index] ?? String(type),
    type,
    ...(schema.output_is_list?.[index] === undefined
      ? {}
      : { is_list: Boolean(schema.output_is_list[index]) }),
  }));
}

function minimalNode(classType, schema) {
  return {
    class_type: classType,
    display_name: schema.display_name ?? classType,
    category: schema.category ?? "",
    description: schema.description ?? "",
    python_module: schema.python_module ?? "",
    inputs: [
      ...inputRows(schema.input?.required, true),
      ...inputRows(schema.input?.optional, false),
    ],
    outputs: outputRows(schema),
  };
}

function searchableText(classType, schema) {
  const inputs = [
    ...Object.entries(schema.input?.required ?? {}),
    ...Object.entries(schema.input?.optional ?? {}),
  ];
  return [
    classType,
    schema.display_name,
    schema.category,
    schema.description,
    ...inputs.flatMap(([name, definition]) => [name, definition?.[0]]),
    ...(schema.output_name ?? []),
    ...(schema.output ?? []),
  ].map((value) => JSON.stringify(value ?? "")).join(" ").toLowerCase();
}

export async function searchNodes({ query, limit = 20 }, {
  baseUrl,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${baseUrl.replace(/\/$/, "")}/object_info`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw unavailableError(baseUrl, error);
  }
  if (!response.ok) {
    throw new McpHostError(
      "COMFYUI_HTTP_ERROR",
      `ComfyUI returned HTTP ${response.status} for /object_info.`,
      { status: response.status },
    );
  }
  let catalog;
  try {
    catalog = await response.json();
  } catch (error) {
    throw new McpHostError(
      "COMFYUI_INVALID_RESPONSE",
      "ComfyUI returned invalid JSON for /object_info.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new McpHostError(
      "COMFYUI_INVALID_RESPONSE",
      "ComfyUI returned an invalid node catalog.",
    );
  }
  const needle = query.trim().toLowerCase();
  const nodes = Object.entries(catalog)
    .filter(([classType, schema]) => searchableText(classType, schema).includes(needle))
    .slice(0, limit)
    .map(([classType, schema]) => minimalNode(classType, schema));
  return { nodes };
}
