import { emitKeypressEvents } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchFile, unwatchFile } from "node:fs";
import { loadConfig, saveConfig, updateEntry, deleteEntry } from "./config-store.mjs";
import { GatewayRuntime } from "./runtime.mjs";
import { formatLogLines } from "./log-view.mjs";

const folder = dirname(fileURLToPath(import.meta.url));
const path = resolve(process.argv[2] || resolve(folder, "../config/config.json"));
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("实时界面需要交互终端。无界面启动请使用 node src/gateway.mjs。");
  process.exit(1);
}
let config;
try {
  config = loadConfig(path);
} catch (error) {
  console.error(`配置无法加载：${error.message}`);
  process.exit(1);
}
const runtime = new GatewayRuntime(resolve(folder, "gateway.mjs"), path);
const tabs = ["首页", "提供商", "模型映射", "设置", "日志"];
let tab = 0,
  cursor = 0,
  modes = ["openai", "ollama"],
  notice = "",
  form = null,
  input = null,
  confirm = null;
let dirty = true,
  quitting = false;
let logDetail = null,
  logOffset = 0,
  logMaximum = 0,
  logPageSize = 1;
const stateNames = { stopped: "已停止", starting: "启动中", running: "运行中", stopping: "停止中" };

// Never allow control sequences from upstream responses to alter the terminal.
function clean(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
function width(character) {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\u{1f000}-\u{1ffff}]/u.test(
    character,
  )
    ? 2
    : 1;
}
function clip(text, maximum) {
  let out = "",
    used = 0;
  for (const character of clean(text)) {
    used += width(character);
    if (used > maximum)
      break;
    out += character;
  }
  return out;
}
function colorLine(text) {
  if (process.env.NO_COLOR !== undefined)
    return text;
  return text.replace(
    /运行中|已启用|完成|启动中|停止中|进行中|已停止|已禁用|失败|错误|\[x\]|\[ \]/g,
    (word) => {
      const color = /运行中|已启用|完成|\[x\]/.test(word)
        ? 32
        : /启动中|停止中|进行中/.test(word)
          ? 33
          : /失败|错误/.test(word)
            ? 31
            : 90;
      return `\x1b[${color}m${word}\x1b[0m`;
    },
  );
}
function entries() {
  return tab === 1 ? Object.entries(config.providers) : tab === 2 ? Object.entries(config.models) : [];
}
// 为不同配置类型生成编辑字段，密钥字段只做遮挡展示。
function fields(section, id = "", value = {}) {
  if (section === "providers")
    return [
      { key: "id", label: "提供商 ID", value: id },
      { key: "baseUrl", label: "API 基础地址", value: value.baseUrl || "https://" },
      { key: "apiKey", label: "API Key", value: value.apiKey || "", secret: true },
      { key: "apiKeyEnv", label: "Key 环境变量（优先）", value: value.apiKeyEnv || "" },
    ];
  if (section === "models")
    return [
      { key: "id", label: "公开映射名称", value: id },
      {
        key: "provider",
        label: "提供商 ID",
        value: value.provider || Object.keys(config.providers)[0] || "",
      },
      { key: "model", label: "上游模型名称", value: value.model || "" },
      { key: "enabled", label: "启用模型", value: value.enabled !== false, boolean: true },
      { key: "description", label: "描述备注", value: value.description || "" },
      { key: "tools", label: "工具调用", value: !!value.tools, boolean: true },
      { key: "vision", label: "视觉输入", value: !!value.vision, boolean: true },
      { key: "contextLength", label: "上下文长度（可留空）", value: String(value.contextLength || "") },
    ];
  return [
    { key: "port", label: "本地端口", value: String(config.port) },
    { key: "gatewayKey", label: "网关 Key", value: config.gatewayKey, secret: true },
    { key: "timeoutMs", label: "空闲超时（毫秒）", value: String(config.timeoutMs) },
    { key: "debug", label: "完整调试日志", value: config.debug, boolean: true },
  ];
}
// 打开配置表单；运行中只允许修改支持热重载的模型映射。
function openForm(section, id, value) {
  if (runtime.child && section !== "models")
    throw new Error("提供商和运行设置需先停止代理；模型映射可直接修改");
  form = { section, id, original: value || {}, fields: fields(section, id, value), cursor: 0 };
  notice = "修改后按 Ctrl+S 保存；Esc 放弃。";
}
// 合并表单与最新配置并保存，保留表单之外的配置项。
function persist() {
  config = loadConfig(path);
  const values = Object.fromEntries(form.fields.map((field) => [field.key, field.value]));
  let next;
  if (form.section === "settings")
    next = { ...config, ...values, port: Number(values.port), timeoutMs: Number(values.timeoutMs) };
  else {
    const { id, ...value } = values;
    if (form.section === "models") {
      if (value.contextLength === "")
        delete value.contextLength;
      else
        value.contextLength = Number(value.contextLength);
    }
    const merged = { ...form.original, ...value };
    if (form.section === "models" && values.contextLength === "")
      delete merged.contextLength;
    next = updateEntry(config, form.section, form.id, id.trim(), merged);
  }
  saveConfig(path, next);
  config = next;
  form = null;
  cursor = 0;
  notice = runtime.child ? "已保存，等待模型映射自动重载…" : "已保存。";
}
// 只绘制可见列表区间，让当前选中项保持在窗口内。
function windowed(lines, items, selected, format) {
  const count = Math.max(1, (process.stdout.rows || 25) - 14);
  const begin = Math.max(0, selected - count + 1);
  for (let i = begin; i < Math.min(items.length, begin + count); i++)
    lines.push(`${i === selected ? "›" : " "} ${format(items[i], i)}`);
  if (!items.length)
    lines.push("  暂无记录");
}
// 内容超出显示区域时，在右侧按可见比例绘制滚动位置。
function addScrollbar(lines, start, total, offset, visible, columns) {
  const height = lines.length - start;
  if (!height || total <= visible)
    return;
  const thumb = Math.min(Math.max(1, height - 1), Math.max(1, Math.round((height * visible) / total)));
  const top = Math.round(((height - thumb) * offset) / (total - visible));
  for (let row = 0; row < height; row++) {
    const text = clip(lines[start + row], columns - 2);
    const used = [...text].reduce((sum, character) => sum + width(character), 0);
    lines[start + row] =
      text + " ".repeat(columns - 1 - used) + (row >= top && row < top + thumb ? "█" : "│");
  }
}
function rangeLabel(offset, visible, total, unit) {
  const end = Math.min(total, offset + visible);
  return `${offset + 1}–${end} / ${total} ${unit} · ${Math.round((end / total) * 100)}%`;
}
// 按多行卡片展示提供商或模型，并根据窗口高度分页。
function renderEntries(lines, columns) {
  const items = entries();
  const height = tab === 1 ? 4 : 7;
  const count = Math.max(1, Math.floor(((process.stdout.rows || 25) - 10) / height));
  const begin = Math.max(0, Math.min(cursor - count + 1, items.length - count));
  const start = lines.length;
  for (let i = begin; i < Math.min(items.length, begin + count); i++) {
    const [id, value] = items[i];
    lines.push(`${i === cursor ? "›" : " "} ${id}`);
    if (tab === 1) {
      const keySet = value.apiKey || (value.apiKeyEnv && process.env[value.apiKeyEnv]);
      lines.push(
        `    地址：${value.baseUrl}`,
        `    密钥：${keySet ? "已设置" : "未设置"}  环境变量：${value.apiKeyEnv || "无"}`,
      );
    } else {
      lines.push(
        `    状态  ：${value.enabled === false ? "已禁用" : "已启用"}`,
        `    提供商：${value.provider}`,
        `    模型名：${value.model}`,
        `    备注  ：${value.description || "无"}`,
        `    能力  ：工具 ${value.tools ? "[x]" : "[ ]"}  视觉 ${value.vision ? "[x]" : "[ ]"}`,
      );
    }
    lines.push("");
  }
  if (!items.length)
    lines.push("  暂无记录");
  else {
    addScrollbar(lines, start, items.length, begin, Math.min(count, items.length), columns);
    lines.push(`显示 ${rangeLabel(begin, count, items.length, "项")}（选中 ${cursor + 1}）`);
  }
}
// 分配日志列表和详情区域，按滚动位置展示格式化后的内容。
function renderLogs(lines, columns, rows) {
  const recent = [...runtime.recent].reverse();
  cursor = Math.min(cursor, Math.max(0, recent.length - 1));
  const selected = logDetail || recent[cursor];
  if (!selected) {
    lines.push("暂无日志");
    return;
  }
  if (!logDetail) {
    // Give roughly two thirds of the available content area to the log list.
    const count = Math.min(Math.max(4, Math.floor((rows - 10) * 0.65)), recent.length);
    const begin = Math.max(0, Math.min(cursor - count + 1, recent.length - count));
    const start = lines.length;
    for (let i = begin; i < begin + count; i++) {
      const event = recent[i];
      lines.push(
        `${i === cursor ? "›" : " "} ${event.time?.slice(11, 19) || ""} ${event.id || ""} ${event.event || ""} ${event.status || ""}`,
      );
    }
    addScrollbar(lines, start, recent.length, begin, count, columns);
    lines.push(`日志 ${rangeLabel(begin, count, recent.length, "条")}`);
  }
  logPageSize = Math.max(1, rows - 3 - lines.length - 2);
  let details = formatLogLines(selected, columns);
  if (details.length > logPageSize)
    details = formatLogLines(selected, columns - 2);
  logMaximum = Math.max(0, details.length - logPageSize);
  logOffset = Math.min(logOffset, logMaximum);
  lines.push(`详情 ${rangeLabel(logOffset, logPageSize, details.length, "行")}`);
  const detailStart = lines.length;
  lines.push(...details.slice(logOffset, logOffset + logPageSize));
  addScrollbar(lines, detailStart, details.length, logOffset, Math.min(logPageSize, details.length), columns);
  lines.push(
    logDetail
      ? "↑↓ 滚动  PgUp/PgDn 翻页  Home/End 首尾  Esc 返回"
      : "↑↓ 选日志  PgUp/PgDn 滚动详情  Enter 展开",
  );
}
// 根据当前页面和编辑状态重绘终端，预留固定的底部操作提示。
function render() {
  if (!dirty || quitting)
    return;
  dirty = false;
  const columns = Math.max(10, (process.stdout.columns || 80) - 1),
    rows = process.stdout.rows || 25;
  if (rows < 18 || columns < 45) {
    process.stdout.write("\x1b[H\x1b[J请放大终端至至少 46 列 × 18 行。Q 退出。");
    return;
  }
  const lines = [
    `本地模型网关   ● ${stateNames[runtime.state]}   :${config.port}`,
    "",
    tabs.map((name, i) => (i === tab ? `[${name}]` : ` ${name} `)).join("  "),
    "─".repeat(Math.min(columns, 90)),
  ];
  if (form) {
    lines.push(
      `编辑 ${form.section === "providers" ? "提供商" : form.section === "models" ? "模型映射" : "运行设置"}`,
    );
    windowed(
      lines,
      form.fields,
      form.cursor,
      (field) =>
        `${field.label}：${field.secret ? (field.value ? "••••••（已设置）" : "（未设置）") : field.boolean ? (field.value ? "[x]" : "[ ]") : field.value || "（空）"}`,
    );
    lines.push("", "↑↓ 选字段  Enter 编辑/切换  Ctrl+S 保存  Esc 放弃");
  } else if (tab === 0) {
    lines.push(
      `${cursor === 0 ? "›" : " "} [${modes.includes("openai") ? "x" : " "}] OpenAI   http://127.0.0.1:${config.port}/v1`,
      `${cursor === 1 ? "›" : " "} [${modes.includes("ollama") ? "x" : " "}] Ollama   http://127.0.0.1:${config.port}`,
      "",
      `推理请求 ${runtime.total}    进行中 ${runtime.active.size}    失败 ${runtime.failed}`,
      "",
      "最近推理请求",
    );
    for (const request of [...runtime.requests.values()].slice(-Math.max(1, rows - 19)).reverse()) {
      lines.push(
        `  ${request.alias}  ${request.status}  ${request.elapsedMs ?? Date.now() - request.started}ms`,
      );
    }
    lines.push("", "↑↓ 选择入口   Enter 勾选/取消   S 启动/停止");
  } else if (tab === 1 || tab === 2) {
    renderEntries(lines, columns);
    lines.push(
      "",
      tab === 2 ? "↑↓ 选择  Enter 编辑  A 新增  D 删除  E 启用/禁用" : "↑↓ 选择  Enter 编辑  A 新增  D 删除",
    );
  } else if (tab === 3) {
    lines.push(
      `端口：${config.port}`,
      `网关 Key：${config.gatewayKey ? "••••••（已设置）" : "未设置"}`,
      `空闲超时：${config.timeoutMs}ms`,
      `调试日志：${config.debug ? "开启" : "关闭"}`,
      "日志：每文件 1 MiB，保留 3 个备份",
      "",
      "Enter 编辑设置",
    );
  } else {
    renderLogs(lines, columns, rows);
  }
  const footer = input
    ? [
        `${input.field.label}：${input.field.secret ? "•".repeat(Math.min(60, Array.from(input.text).length)) : input.text}▏`,
        "输入新值；Ctrl+U 清空；Enter 确认；Esc 取消",
      ]
    : confirm
      ? [confirm.label, "Y 确认删除 / Esc 取消"]
      : [notice, "Tab / ←→ 切换页面   Q / Ctrl+C 退出并停止代理"];
  const body = lines.slice(0, rows - footer.length - 1);
  while (body.length < rows - footer.length - 1)
    body.push("");
  process.stdout.write(
    "\x1b[H" +
      [...body, ...footer].map((line) => colorLine(clip(line, columns)) + "\x1b[K").join("\r\n") +
      "\x1b[J",
  );
}
// 先停止代理，再移除监听并恢复终端状态。
async function quit() {
  if (quitting)
    return;
  quitting = true;
  await runtime.stop();
  unwatchFile(path, refreshConfig);
  clearInterval(timer);
  process.stdin.off("keypress", keypress);
  process.stdout.off("resize", resized);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}
// 处理字段输入、确认和取消，不在此阶段写入配置文件。
function handleInput(character, key) {
  if (key.name === "escape")
    input = null;
  else if (key.name === "return") {
    input.field.value = input.text;
    input = null;
  } else if (key.name === "backspace")
    input.text = Array.from(input.text).slice(0, -1).join("");
  else if (key.ctrl && key.name === "u")
    input.text = "";
  else if (
    character &&
    !key.ctrl &&
    !key.meta &&
    !["left", "right", "up", "down", "tab", "delete", "home", "end"].includes(key.name)
  )
    input.text += clean(character);
}
// 处理表单导航、布尔开关和整张表单的保存。
function handleForm(key) {
  if (key.name === "escape") {
    form = null;
    notice = "已放弃未保存修改。";
  } else if (key.ctrl && key.name === "s")
    persist();
  else if (key.name === "up")
    form.cursor = Math.max(0, form.cursor - 1);
  else if (key.name === "down")
    form.cursor = Math.min(form.fields.length - 1, form.cursor + 1);
  else if (key.name === "return" || key.name === "space") {
    const field = form.fields[form.cursor];
    if (field.boolean)
      field.value = !field.value;
    else
      input = { field, text: "" };
  }
}
// 处理配置列表的编辑、增删，以及模型启用状态切换。
function handleList(character, key) {
  const list = tab === 4 ? runtime.recent : entries();
  if (key.name === "up")
    cursor = Math.max(0, cursor - 1);
  else if (key.name === "down")
    cursor = Math.min(Math.max(0, list.length - 1), cursor + 1);
  else if (tab === 1 || tab === 2) {
    const section = tab === 1 ? "providers" : "models";
    if (character?.toLowerCase() === "a")
      openForm(section);
    else if (key.name === "return" && list[cursor])
      openForm(section, ...list[cursor]);
    else if (character?.toLowerCase() === "d" && list[cursor]) {
      if (runtime.child && section !== "models")
        throw new Error("请先停止代理再修改提供商");
      const id = list[cursor][0];
      confirm = {
        label: `删除 ${id}？`,
        action: () => {
          const next = deleteEntry(loadConfig(path), section, id);
          saveConfig(path, next);
          config = next;
          cursor = 0;
        },
      };
    } else if (section === "models" && character?.toLowerCase() === "e" && list[cursor]) {
      const id = list[cursor][0];
      const next = loadConfig(path);
      if (!next.models[id])
        throw new Error("模型已被删除，请刷新列表");
      next.models[id].enabled = next.models[id].enabled === false;
      saveConfig(path, next);
      config = next;
      notice = runtime.child ? "已保存，等待模型映射自动重载…" : "模型状态已保存。";
    }
  }
}
// 区分日志选择和详情滚动，展开时固定当前日志内容。
function handleLogs(key) {
  if (key.name === "escape") {
    logDetail = null;
    logOffset = 0;
  } else if (key.name === "return" && !logDetail) {
    logDetail = [...runtime.recent].reverse()[cursor] || null;
    logOffset = 0;
  } else if (key.name === "pageup")
    logOffset = Math.max(0, logOffset - logPageSize);
  else if (key.name === "pagedown")
    logOffset = Math.min(logMaximum, logOffset + logPageSize);
  else if (key.name === "home")
    logOffset = 0;
  else if (key.name === "end")
    logOffset = logMaximum;
  else if (key.name === "up" || key.name === "down") {
    const step = key.name === "up" ? -1 : 1;
    if (logDetail)
      logOffset = Math.max(0, Math.min(logMaximum, logOffset + step));
    else {
      cursor = Math.max(0, Math.min(runtime.recent.length - 1, cursor + step));
      logOffset = 0;
    }
  }
}
// 按输入框、确认框、表单和页面的优先级分发按键。
async function keypress(character, key = {}) {
  if (quitting)
    return;
  try {
    if (key.ctrl && key.name === "c")
      return await quit();
    if (input)
      handleInput(character, key);
    else if (confirm) {
      if (character?.toLowerCase() === "y") {
        confirm.action();
        confirm = null;
        notice = "已删除并保存。";
      } else if (key.name === "escape")
        confirm = null;
    } else if (form)
      handleForm(key);
    else if (character?.toLowerCase() === "q")
      return await quit();
    else if (key.name === "tab" || key.name === "right" || key.name === "left") {
      tab = (tab + (key.name === "left" || key.shift ? -1 : 1) + tabs.length) % tabs.length;
      cursor = 0;
      notice = "";
      logDetail = null;
      logOffset = 0;
    } else if (tab === 0) {
      if (key.name === "up")
        cursor = Math.max(0, cursor - 1);
      else if (key.name === "down")
        cursor = Math.min(1, cursor + 1);
      else if (key.name === "return" || character === "1" || character === "2") {
        if (runtime.child)
          throw new Error("请先停止代理再切换入口");
        if (character === "1" || character === "2")
          cursor = Number(character) - 1;
        const mode = cursor === 0 ? "openai" : "ollama";
        modes = modes.includes(mode) ? modes.filter((item) => item !== mode) : [...modes, mode];
      } else if (character?.toLowerCase() === "s") {
        if (runtime.child)
          await runtime.stop();
        else {
          config = loadConfig(path);
          runtime.start(modes);
          notice = "正在启动代理…";
        }
      }
    } else if (tab === 3 && key.name === "return")
      openForm("settings");
    else if (tab === 4)
      handleLogs(key);
    else
      handleList(character, key);
  } catch (error) {
    notice = error.message;
  }
  dirty = true;
  render();
}
function resized() {
  dirty = true;
  render();
}
runtime.on("change", () => {
  const latest = runtime.recent.at(-1);
  if (latest?.event === "listening")
    notice = "代理已启动，模型映射支持热重载。";
  else if (latest?.event === "models.reloaded")
    notice = `模型映射已热重载，${latest.count} 个模型已启用。`;
  else if (latest?.event === "models.reload.error")
    notice = "重载失败，继续使用原配置：" + latest.message;
  else if (latest?.event === "error")
    notice = latest.message || "请求出错，请查看日志页。";
  else if (latest?.event === "stopped")
    notice = latest.message;
  dirty = true;
});
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
// 同步外部配置变化到界面，读取失败时保留当前配置。
function refreshConfig() {
  try {
    config = loadConfig(path);
    cursor = Math.min(cursor, Math.max(0, entries().length - 1));
  } catch {
    notice = "配置文件错误，保留当前界面配置。";
  }
  dirty = true;
}
watchFile(path, { interval: 500, persistent: false }, refreshConfig);
process.stdin.on("keypress", keypress);
process.stdout.on("resize", resized);
process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
const timer = setInterval(() => {
  if (runtime.active.size)
    dirty = true;
  render();
}, 200);
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
render();
