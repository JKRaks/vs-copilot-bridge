// Translate only the Ollama chat surface; upstreams remain OpenAI compatible.
// 识别图片类型并生成 data URL，避免将所有图片误标为 PNG。
function imageUrl(image) {
  if (image.startsWith("data:"))
    return image;
  const bytes = Buffer.from(image, "base64");
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    mime = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mime = "image/jpeg";
  else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii")))
    mime = "image/gif";
  else if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    mime = "image/webp";
  else
    throw Object.assign(new Error("Unsupported image format; use PNG, JPEG, GIF or WebP"), { status: 400 });
  return `data:${mime};base64,${image}`;
}

// 把 Ollama 聊天转换为 OpenAI 请求，并匹配工具调用与工具结果。
export function toOpenAI(body, model) {
  const pending = [];
  let callIndex = 0;
  const messages = (body.messages || []).map((message) => {
    const result = { role: message.role, content: message.content ?? "" };
    if (message.images?.length) {
      result.content = [
        { type: "text", text: result.content },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: { url: imageUrl(image) },
        })),
      ];
    }
    if (message.tool_calls?.length) {
      result.tool_calls = message.tool_calls.map((call) => {
        const id = call.id || `call_gateway_${callIndex++}`;
        pending.push({ id, name: call.function.name });
        return {
          id,
          type: "function",
          function: {
            name: call.function.name,
            arguments:
              typeof call.function.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function.arguments || {}),
          },
        };
      });
    }
    if (message.role === "tool") {
      const index = pending.findIndex((call) =>
        message.tool_call_id
          ? call.id === message.tool_call_id
          : !message.tool_name || call.name === message.tool_name,
      );
      if (index < 0)
        throw Object.assign(new Error("Tool result has no matching assistant tool call"), { status: 400 });
      result.tool_call_id = pending.splice(index, 1)[0].id;
    }
    return result;
  });
  const request = { model, messages, stream: body.stream !== false };
  if (body.tools)
    request.tools = body.tools;
  if (body.format === "json")
    request.response_format = { type: "json_object" };
  else if (body.format && typeof body.format === "object") {
    request.response_format = { type: "json_schema", json_schema: { name: "response", schema: body.format } };
  }
  for (const key of ["temperature", "top_p", "stop", "seed"]) {
    if (body.options?.[key] !== undefined)
      request[key] = body.options[key];
  }
  if (body.options?.num_predict > 0)
    request.max_tokens = body.options.num_predict;
  return request;
}

function toolCalls(calls) {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.function.name,
      arguments:
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments || "{}")
          : call.function.arguments,
    },
  }));
}
function envelope(model, message, done, reason, usage) {
  return {
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", ...message },
    done,
    ...(done
      ? {
          done_reason: reason === "length" ? "length" : "stop",
          ...(usage ? { prompt_eval_count: usage.prompt_tokens, eval_count: usage.completion_tokens } : {}),
        }
      : {}),
  };
}
// 把完整的 OpenAI 聊天响应转换为 Ollama 消息和用量信息。
export function fromOpenAI(body, model) {
  if (body.error)
    throw new Error(JSON.stringify(body.error));
  const choice = body.choices?.[0];
  if (!choice)
    throw new Error("Upstream returned no chat choices");
  const message = { content: choice.message.content || "" };
  if (choice.message.reasoning_content)
    message.thinking = choice.message.reasoning_content;
  if (choice.message.tool_calls)
    message.tool_calls = toolCalls(choice.message.tool_calls);
  return envelope(model, message, true, choice.finish_reason, body.usage);
}

// UTF-8 decoding is supplied by the caller. SSE boundaries may span TCP chunks.
// 按 SSE 事件边界组装数据，允许一个事件跨越多个网络分块。
export async function* sseEvents(chunks) {
  let pending = "";
  function parse(frame) {
    const lines = frame.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:"));
    return lines.length ? lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n") : null;
  }
  for await (const chunk of chunks) {
    pending += chunk;
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const data = parse(pending.slice(0, boundary.index));
      pending = pending.slice(boundary.index + boundary[0].length);
      if (data !== null)
        yield data;
    }
  }
  if (pending.trim()) {
    const data = parse(pending);
    if (data !== null)
      yield data;
  }
}

// 转换流式文本和思考内容；工具参数收齐后再输出，避免半截 JSON。
export async function* toOllamaStream(chunks, model) {
  const calls = new Map();
  let reason,
    usage,
    finished = false;
  for await (const data of sseEvents(chunks)) {
    if (data === "[DONE]")
      break;
    const packet = JSON.parse(data);
    if (packet.error)
      throw new Error(JSON.stringify(packet.error));
    if (packet.usage)
      usage = packet.usage;
    const choice = packet.choices?.[0];
    if (!choice)
      continue;
    const delta = choice.delta || {};
    const message = { content: delta.content || "" };
    if (delta.reasoning_content)
      message.thinking = delta.reasoning_content;
    for (const fragment of delta.tool_calls || []) {
      const index = fragment.index ?? 0;
      const call = calls.get(index) || { id: "", function: { name: "", arguments: "" } };
      if (fragment.id)
        call.id = fragment.id;
      if (fragment.function?.name)
        call.function.name += fragment.function.name;
      if (fragment.function?.arguments)
        call.function.arguments += fragment.function.arguments;
      calls.set(index, call);
    }
    if (message.content || message.thinking)
      yield envelope(model, message, false);
    if (choice.finish_reason) {
      reason = choice.finish_reason;
      finished = true;
    }
  }
  if (!finished)
    throw new Error("Upstream stream ended without finish_reason");
  if (calls.size)
    yield envelope(model, { content: "", tool_calls: toolCalls([...calls.values()]) }, false);
  yield envelope(model, { content: "" }, true, reason, usage);
}
