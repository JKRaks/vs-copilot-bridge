import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toOpenAI, toOllamaStream } from "../src/ollama.mjs";
import { createLogger } from "../src/logger.mjs";

test("image formats preserve content and MIME; multiple named tool results match IDs", () => {
  const images = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    Buffer.from([255, 216, 255, 224]).toString("base64"),
    Buffer.from("GIF89a").toString("base64"),
    Buffer.from("RIFF1234WEBP").toString("base64"),
  ];
  const request = toOpenAI({ messages: [{ role: "user", content: "图片", images }] }, "real");
  for (const [i, type] of ["png", "jpeg", "gif", "webp"].entries())
    assert.equal(request.messages[0].content[i + 1].image_url.url, `data:image/${type};base64,${images[i]}`);
  const history = toOpenAI(
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "a", function: { name: "one", arguments: {} } },
            { id: "b", function: { name: "two", arguments: {} } },
          ],
        },
        { role: "tool", tool_name: "two", content: "2" },
        { role: "tool", tool_name: "one", content: "1" },
      ],
    },
    "real",
  );
  assert.equal(history.messages[1].tool_call_id, "b");
  assert.equal(history.messages[2].tool_call_id, "a");
});

test("logs roll at 1 MiB, redact secrets and split oversize JSON records", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-log-test-"));
  const path = join(directory, "gateway.jsonl");
  const log = createLogger(path, { secrets: ["private-value"], consoleOutput: false });
  for (let i = 0; i < 8; i++)
    log("test", "normal", { text: "a".repeat(600000), key: "private-value" });
  assert.equal(readdirSync(directory).length, 4);
  log("test", "large", { text: "图片".repeat(200000) });
  for (const file of readdirSync(directory)) {
    assert.ok(statSync(join(directory, file)).size <= 1024 * 1024);
    const text = readFileSync(join(directory, file), "utf8");
    assert.ok(!text.includes("private-value"));
    for (const line of text.trim().split("\n"))
      JSON.parse(line);
  }
  assert.ok(readFileSync(path, "utf8").includes("log.fragment"));
  // directory is a newly created isolated temp directory, never a user-selected path.
  rmSync(directory, { recursive: true, force: true });
});

test("Ollama split SSE, tools, thinking, usage, and tool history", async () => {
  const packets = [
    { choices: [{ delta: { reasoning_content: "思考", content: "你好" } }] },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "read", arguments: '{"x":' } }] },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ];
  const text = packets.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  async function* chunks() {
    for (let i = 0; i < text.length; i += 7)
      yield text.slice(i, i + 7);
  }
  const result = [];
  for await (const p of toOllamaStream(chunks(), "alias"))
    result.push(p);
  assert.equal(result[0].message.content, "你好");
  assert.equal(result[0].message.thinking, "思考");
  assert.deepEqual(result[1].message.tool_calls[0].function.arguments, { x: 1 });
  assert.equal(result.at(-1).done, true);
  assert.equal(result.at(-1).eval_count, 4);
  const body = toOpenAI(
    {
      messages: [
        { role: "assistant", tool_calls: result[1].message.tool_calls },
        { role: "tool", tool_name: "read", content: "result" },
      ],
    },
    "real",
  );
  assert.equal(body.messages[1].tool_call_id, "call1");
  async function* truncated() {
    yield 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
  }
  await assert.rejects(async () => {
    for await (const p of toOllamaStream(truncated(), "alias")) {
    }
  }, /finish_reason/);
});

test("both HTTP entrances, model routing, auth, SSE and errors", async () => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req)
      raw += c;
    const body = JSON.parse(raw);
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (body.model === "error") {
      res.writeHead(429);
      res.end('{"error":{"message":"limited"}}');
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text =
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: "你好 OK" }, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n";
      const bytes = Buffer.from(text);
      const cut = bytes.indexOf(Buffer.from("你好")) + 1;
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 20);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const temp = mkdtempSync(join(tmpdir(), "model-gateway-test-"));
  const config = join(temp, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      port,
      gatewayKey: "test-local",
      providers: {
        a: { baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: "key-a" },
        b: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "key-b" },
      },
      models: {
        A: { provider: "a", model: "real-a" },
        B: { provider: "b", model: "real-b", tools: true },
        E: { provider: "b", model: "error" },
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/gateway.mjs", import.meta.url)), config],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Startup timeout")), 5000);
      child.stdout.on("data", (data) => {
        if (data.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });
    const base = `http://127.0.0.1:${port}`;
    const call = (path, body) =>
      fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { authorization: "Bearer test-local", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await fetch(base + "/v1/models")).status, 401);
    assert.equal((await (await call("/v1/models")).json()).data.length, 3);
    assert.equal((await (await call("/api/tags")).json()).models.length, 3);
    assert.ok((await (await call("/api/show", { model: "B" })).json()).capabilities.includes("tools"));
    assert.equal((await call("/v1/models/missing")).status, 404);
    await (await call("/v1/chat/completions", { model: "A", messages: [] })).text();
    assert.equal(seen.at(-1).url, "/chat/completions");
    assert.equal(seen.at(-1).auth, "Bearer key-a");
    assert.equal(seen.at(-1).body.model, "real-a");
    await (await call("/v1/responses", { model: "B", input: "hi" })).text();
    assert.equal(seen.at(-1).url, "/v1/responses");
    assert.equal(seen.at(-1).auth, "Bearer key-b");
    const plain = await (await call("/api/chat", { model: "B", messages: [], stream: false })).json();
    assert.equal(plain.message.content, "OK");
    assert.equal(plain.model, "B");
    assert.equal(plain.done, true);
    const stream = await (await call("/api/chat", { model: "B", messages: [] })).text();
    const lines = stream.trim().split("\n").map(JSON.parse);
    assert.equal(lines[0].message.content, "你好 OK");
    assert.equal(lines.at(-1).done, true);
    const passthrough = await (
      await call("/v1/chat/completions", { model: "A", messages: [], stream: true })
    ).text();
    assert.ok(passthrough.includes("你好 OK"));
    assert.ok(passthrough.includes("[DONE]"));
    assert.equal((await call("/api/chat", { model: "E", messages: [] })).status, 429);
    assert.equal((await call("/v1/chat/completions", { model: "missing" })).status, 404);
  } finally {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    rmSync(temp, { recursive: true, force: true });
  }
});

test("only selected protocol routes are enabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-mode-test-"));
  try {
    for (const mode of ["openai", "ollama"]) {
      const probe = http.createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const config = join(directory, "config.json");
      writeFileSync(config, JSON.stringify({ port, providers: {}, models: {} }));
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../src/gateway.mjs", import.meta.url)), config],
        {
          env: { ...process.env, GATEWAY_MODES: mode },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Startup timeout")), 5000);
          child.stdout.on("data", (data) => {
            if (data.toString().includes("listening")) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("error", reject);
        });
        const base = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(base + "/v1/models")).status, mode === "openai" ? 200 : 404);
        assert.equal((await fetch(base + "/api/tags")).status, mode === "ollama" ? 200 : 404);
        assert.deepEqual((await (await fetch(base + "/health")).json()).modes, [mode]);
      } finally {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
