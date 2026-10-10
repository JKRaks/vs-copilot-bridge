import { StringDecoder } from "node:string_decoder";

// 按完整 SSE 帧识别结束事件，避免结束标志跨分块时漏判。
export function createCompletionTracker(responsesApi = false) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let completed = false;

  return {
    get completed() {
      return completed;
    },
    accept(chunk) {
      pending += decoder.write(chunk);
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");

        if (!data)
          continue;
        if (data === "[DONE]") {
          if (!responsesApi)
            completed = true;
          continue;
        }

        const event = JSON.parse(data);
        if (event.error || ["error", "response.failed", "response.incomplete"].includes(event.type))
          throw new Error("Upstream returned a failed or incomplete SSE event");
        if (responsesApi && event.type === "response.completed")
          completed = true;
      }
    },
  };
}

// 等待响应写入完成；客户端提前断开时不能把上游完成误当成交付成功。
export function finishResponse(res) {
  if (res.writableFinished)
    return Promise.resolve();
  if (res.destroyed)
    return Promise.reject(new Error("Client disconnected"));

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("finish", finished);
      res.off("close", closed);
      res.off("error", failed);
    };
    const finished = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("Client disconnected"));
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    res.once("finish", finished);
    res.once("close", closed);
    res.once("error", failed);
    res.end();
  });
}

// 结束帧已完整转发后即结束读取，不再依赖上游连接是否规范关闭。
export async function relayOpenAI(response, res, { stream, responsesApi, write, onChunk }) {
  const sse = stream && /text\/event-stream/i.test(response.headers["content-type"] || "")
    && !response.headers["content-encoding"];
  const tracker = sse ? createCompletionTracker(responsesApi) : null;
  let receivedBytes = 0;
  for await (const chunk of response) {
    receivedBytes += chunk.length;
    onChunk(chunk);
    tracker?.accept(chunk);
    await write(res, chunk);
    if (tracker?.completed)
      break;
  }

  if (tracker && !tracker.completed)
    throw new Error("Upstream SSE ended without a completion event");

  return { receivedBytes, completion: tracker ? "sse" : "http" };
}
