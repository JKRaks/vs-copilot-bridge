import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalInput, hitTest } from "../src/terminal-input.mjs";

test("fragmented SGR reports are removed while Unicode and keyboard sequences survive", () => {
  const events = [];
  const input = new TerminalInput((event) => events.push(event));
  let text = "";
  input.on("data", (chunk) => {
    text += chunk.toString();
  });
  const bytes = Buffer.from("中\x1b[<0;12;4M\x1b[<0;12;4m\x1b[A文");
  for (const byte of bytes)
    input.write(Buffer.from([byte]));
  input.end();
  assert.equal(text, "中\x1b[A文");
  assert.deepEqual(events, [{ type: "click", x: 11, y: 3 }]);
});

test("wheel reports, release, drag and modifier clicks do not leak as hotkeys", () => {
  const events = [];
  const input = new TerminalInput((event) => events.push(event));
  let text = "";
  input.on("data", (chunk) => {
    text += chunk.toString();
  });
  input.end("\x1b[<64;3;8M\x1b[<65;3;8M\x1b[<32;3;8M\x1b[<4;3;8M\x1b[<2;3;8M");
  assert.equal(text, "");
  assert.deepEqual(events, [
    { type: "wheel", x: 2, y: 7, direction: -1 },
    { type: "wheel", x: 2, y: 7, direction: 1 },
  ]);
});

test("standalone Escape is delivered and truncated mouse reports are discarded", async () => {
  const input = new TerminalInput(() => assert.fail("Unexpected mouse event"), 5);
  let text = "";
  input.on("data", (chunk) => {
    text += chunk.toString();
  });
  input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(text, "\x1b");
  input.write("\x1b[<0;10;");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.end("abc");
  assert.equal(text, "\x1babc");
});

test("hit regions use exclusive edges and the last overlay wins", () => {
  const background = { x: 0, y: 0, width: 30, height: 10 };
  const button = { x: 2, y: 3, width: 5, height: 1 };
  assert.equal(hitTest([background, button], 2, 3), button);
  assert.equal(hitTest([background, button], 7, 3), background);
  assert.equal(hitTest([background, button], 2, 4), background);
  assert.equal(hitTest([background, button], 30, 0), undefined);
});
