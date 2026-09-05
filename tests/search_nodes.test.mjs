import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../mcp_host/server.mjs";

const objectInfo = {
  OpenBioLoadH5AD: {
    display_name: "Load H5AD",
    category: "OpenBio/Single Cell/Input",
    description: "Load an AnnData matrix from disk.",
    python_module: "custom_nodes.openbio-singlecell.nodes.io",
    input: {
      required: { path: ["STRING", { default: "" }] },
      optional: { backed: ["BOOLEAN", { default: false }] },
    },
    output: ["ANNDATA"],
    output_name: ["adata"],
    output_is_list: [false],
  },
  OpenBioPlotEmbedding: {
    display_name: "Plot Embedding",
    category: "OpenBio/Single Cell/Plot",
    description: "Render a dimensionality reduction.",
    python_module: "custom_nodes.openbio-singlecell.nodes.plot",
    input: {
      required: { embedding: ["EMBEDDING", {}] },
    },
    output: ["IMAGE"],
    output_name: ["image"],
  },
};

async function startCatalogServer(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    const prefix = "/object_info/";
    if (request.url?.startsWith(prefix)) {
      const classType = decodeURIComponent(request.url.slice(prefix.length));
      const schema = objectInfo[classType];
      response.end(JSON.stringify(schema === undefined ? {} : {
        [classType]: schema,
      }));
      return;
    }
    response.end(JSON.stringify(objectInfo));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

async function connectClient(t, baseUrl) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ baseUrl });
  const client = new Client({ name: "search-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

test("search_nodes finds every documented catalog field and returns a minimal schema", async (t) => {
  const catalog = await startCatalogServer(t);
  const client = await connectClient(t, catalog.baseUrl);

  for (const query of [
    "OpenBioLoadH5AD",
    "Load H5AD",
    "Input",
    "AnnData matrix",
    "path",
    "adata",
  ]) {
    const result = await client.callTool({
      name: "search_nodes",
      arguments: { query },
    });
    assert.deepEqual(result.structuredContent, {
      instance_id: "configured",
      nodes: [{
        class_type: "OpenBioLoadH5AD",
        display_name: "Load H5AD",
        category: "OpenBio/Single Cell/Input",
        description: "Load an AnnData matrix from disk.",
        python_module: "custom_nodes.openbio-singlecell.nodes.io",
        inputs: [
          { name: "path", type: "STRING", required: true },
          { name: "backed", type: "BOOLEAN", required: false },
        ],
        outputs: [{
          index: 0,
          name: "adata",
          type: "ANNDATA",
          is_list: false,
        }],
      }],
    });
  }

  assert.deepEqual(
    catalog.requests,
    Array(6).fill({ method: "GET", url: "/object_info" }),
  );
});

test("inspect_node_type returns the complete native schema for an exact class type", async (t) => {
  const catalog = await startCatalogServer(t);
  const client = await connectClient(t, catalog.baseUrl);

  const result = await client.callTool({
    name: "inspect_node_type",
    arguments: { class_type: "OpenBioLoadH5AD" },
  });

  assert.deepEqual(result.structuredContent, {
    instance_id: "configured",
    class_type: "OpenBioLoadH5AD",
    schema: objectInfo.OpenBioLoadH5AD,
  });
  assert.deepEqual(catalog.requests, [{
    method: "GET",
    url: "/object_info/OpenBioLoadH5AD",
  }]);
});

test("inspect_node_type reports an unknown class type", async (t) => {
  const catalog = await startCatalogServer(t);
  const client = await connectClient(t, catalog.baseUrl);

  const result = await client.callTool({
    name: "inspect_node_type",
    arguments: { class_type: "MissingNode" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "NODE_TYPE_NOT_FOUND",
      message: "ComfyUI node type is not installed: MissingNode.",
      details: { class_type: "MissingNode" },
    },
  });
});
