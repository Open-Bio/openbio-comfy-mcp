import assert from "node:assert/strict";
import test from "node:test";

import { McpHostError } from "../mcp_host/errors.mjs";
import { POLL_MS, inspectPrompt, waitForPrompt } from "../mcp_host/prompt.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("inspect_prompt adds view URLs to completed outputs", async () => {
  const value = await inspectPrompt({ prompt_id: "prompt-9" }, {
    baseUrl: "http://127.0.0.1:8188",
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:8188/openbio-comfy-mcp/prompt/prompt-9");
      return jsonResponse({
        ok: true,
        result: {
          prompt_id: "prompt-9",
          status: "completed",
          outputs: [{
            node_id: "9",
            filename: "out.png",
            subfolder: "runs",
            type: "output",
            path: "/comfy/output/runs/out.png",
          }],
        },
      });
    },
  });

  assert.equal(value.status, "completed");
  assert.equal(
    value.outputs[0].view_url,
    "http://127.0.0.1:8188/view?filename=out.png&subfolder=runs&type=output",
  );
  assert.equal(value.outputs[0].path, "/comfy/output/runs/out.png");
});

test("wait_for_prompt polls until completed without holding a canvas command", async () => {
  const statuses = ["queued", "running", "completed"];
  const sleeps = [];
  const value = await waitForPrompt({ prompt_id: "prompt-9" }, {
    baseUrl: "http://127.0.0.1:8188",
    fetchImpl: async () => jsonResponse({
      ok: true,
      result: {
        prompt_id: "prompt-9",
        status: statuses.shift(),
        outputs: statuses.length ? [] : [{
          node_id: "9",
          filename: "out.png",
          subfolder: "",
          type: "output",
          path: "/comfy/output/out.png",
        }],
      },
    }),
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(value.status, "completed");
  assert.equal(value.outputs[0].filename, "out.png");
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS]);
});

test("inspect_prompt keeps an execution error instead of treating it as completed", async () => {
  const value = await inspectPrompt({ prompt_id: "prompt-9" }, {
    baseUrl: "http://127.0.0.1:8188",
    fetchImpl: async () => jsonResponse({
      ok: true,
      result: {
        prompt_id: "prompt-9",
        status: "error",
        outputs: [],
        error: {
          node_id: "9",
          node_type: "KSampler",
          exception_message: "CUDA out of memory",
          exception_type: "RuntimeError",
        },
      },
    }),
  });

  assert.deepEqual(value, {
    prompt_id: "prompt-9",
    status: "error",
    outputs: [],
    error: {
      node_id: "9",
      node_type: "KSampler",
      exception_message: "CUDA out of memory",
      exception_type: "RuntimeError",
    },
  });
});

test("wait_for_prompt returns when the prompt ends in error", async () => {
  const value = await waitForPrompt({ prompt_id: "prompt-9" }, {
    baseUrl: "http://127.0.0.1:8188",
    fetchImpl: async () => jsonResponse({
      ok: true,
      result: {
        prompt_id: "prompt-9",
        status: "error",
        outputs: [],
        error: { exception_message: "CUDA out of memory" },
      },
    }),
    sleep: async () => {
      throw new Error("should not poll after a terminal error");
    },
  });

  assert.equal(value.status, "error");
  assert.equal(value.error.exception_message, "CUDA out of memory");
});

test("wait_for_prompt times out while a prompt is still running", async () => {
  await assert.rejects(
    () => waitForPrompt({ prompt_id: "prompt-9", timeout_seconds: 1 }, {
      baseUrl: "http://127.0.0.1:8188",
      fetchImpl: async () => jsonResponse({
        ok: true,
        result: { prompt_id: "prompt-9", status: "running", outputs: [] },
      }),
      sleep: async () => {},
    }),
    (error) => error instanceof McpHostError
      && error.code === "PROMPT_TIMEOUT"
      && error.details.status === "running",
  );
});
