import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createCompletionTracker } from "../src/stream-response.mjs";
import { GatewayRuntime } from "../src/runtime.mjs";

test("completion markers require complete SSE frames and respect API errors", () => {
  const tracker = createCompletionTracker();
  tracker.accept(Buffer.from('data: {"choices":[{"delta":{"content":"[DONE]"}}]}\n\n'));
  assert.equal(tracker.completed, false);
  tracker.accept(Buffer.from("data: [DO"));
  assert.equal(tracker.completed, false);
  tracker.accept(Buffer.from("NE]\n\n"));
  assert.equal(tracker.completed, true);

  const responses = createCompletionTracker(true);
  responses.accept(Buffer.from('data: {"type":"response.completed"}\n\n'));
  assert.equal(responses.completed, true);
  assert.throws(() => createCompletionTracker(true).accept(
    Buffer.from('data: {"type":"response.failed"}\n\n'),
  ), /failed/);
});

test("runtime uses explicit final outcomes and does not count cancellation as failure", () => {
  const runtime = new GatewayRuntime("unused", "unused");
  for (const [id, outcome, status] of [["a", "success", "完成"], ["b", "failed", "失败"], ["c", "cancelled", "已取消"]]) {
    runtime.record({ id, event: "upstream.request" });
    runtime.record({ id, event: "request.end", outcome });
    assert.equal(runtime.requests.get(id).status, status);
  }
  runtime.record({ id: "a", event: "error", message: "late transport event" });
  assert.equal(runtime.requests.get("a").status, "完成");
  assert.equal(runtime.failed, 1);
  assert.equal(runtime.active.size, 0);
});

test("gateway accepts terminal SSE before abnormal HTTP close, rejects truncation and tracks cancellation", async () => {
  const prefix = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n';
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req)
      raw += chunk;
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream", "content-length": 100000 });
    res.write(prefix);
    if (body.model === "cancel")
      return;
    const timer = setTimeout(() => {
      if (body.model === "complete")
        res.write("data: [DONE]\n\n");
      res.end();
      res.socket?.destroy();
    }, 30);
    res.once("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), "gateway-stream-"));
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({
    port,
    providers: { mock: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "test" } },
    models: Object.fromEntries(["complete", "truncated", "cancel"].map((model) => [model, { provider: "mock", model }])),
  }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/gateway.mjs", import.meta.url)), config], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
      if (check())
        return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("Timed out waiting for gateway event");
  }
  const call = (model, signal) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [], stream: true }),
    signal,
  });
  try {
    await waitFor(() => logs.includes('"listening"'));
    const complete = await call("complete");
    assert.equal(await complete.text(), prefix + "data: [DONE]\n\n");
    await waitFor(() => logs.includes('"outcome":"success"'));
    const truncated = await call("truncated");
    await assert.rejects(truncated.text());
    await waitFor(() => logs.includes('"outcome":"failed"'));
    const controller = new AbortController();
    const cancelled = await call("cancel", controller.signal);
    await cancelled.body.getReader().read();
    controller.abort();
    await waitFor(() => logs.includes('"outcome":"cancelled"'));
    const endings = logs.split("\n").filter(Boolean).map(JSON.parse).filter((event) => event.event === "request.end");
    assert.deepEqual(endings.map((event) => event.outcome), ["success", "failed", "cancelled"]);
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
