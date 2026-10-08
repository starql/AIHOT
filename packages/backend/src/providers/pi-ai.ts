// 将 pi-ai 的 Responses 流转换成现有回执格式；所有业务输出继续交给 chatJson 校验。
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ContentPart } from "./llm.ts";
import { piCredentials, piModels } from "./pi-auth.ts";
import { ProviderRejectedError } from "./receipts.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

export const CHATGPT_DEFAULT_MODEL = "gpt-6-luna";

export function chatgptModelId(): string {
  return process.env.CHATGPT_MODEL || CHATGPT_DEFAULT_MODEL;
}

export function chatgptSupportsVision(): boolean {
  return piModels.getModel("openai", chatgptModelId())?.input.includes("image") === true;
}

async function userContent(user: string | ContentPart[]): Promise<UserMessage["content"]> {
  if (typeof user === "string") return user;
  const content: Exclude<UserMessage["content"], string> = [];
  for (const part of user) {
    if (part.type === "text") content.push(part);
    else {
      const embedded = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url.url);
      if (embedded) {
        if (Buffer.byteLength(embedded[2]!, "base64") > 8 * 1024 * 1024) throw new Error("模型图片不能超过 8MB");
        content.push({ type: "image", mimeType: embedded[1]!, data: embedded[2]!.replace(/\s/g, "") });
      } else {
        const image = await guardedFetch(part.image_url.url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000 });
        const mimeType = image.headers.get("content-type")?.split(";")[0] ?? "";
        if (image.status !== 200 || !/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) throw new Error("模型图片读取失败或格式不支持");
        content.push({ type: "image", mimeType, data: image.body.toString("base64") });
      }
    }
  }
  return content;
}

export async function prepareChatgpt(modelId: string, user: string | ContentPart[]) {
  const model = piModels.getModel("openai", modelId);
  if (!model) throw new Error(`pi-ai 不支持模型 ${modelId}，请修改 CHATGPT_MODEL`);
  const saved = await piCredentials.read("openai");
  if (saved?.type !== "oauth") throw new Error("请先在后台连接 ChatGPT 订阅");
  try {
    const auth = await piModels.getAuth(model, { signal: AbortSignal.timeout(20_000) });
    if (auth?.source !== "OAuth") throw new Error("not OAuth");
  } catch {
    throw new Error("ChatGPT 授权不可用，请检查网络；若授权已撤销，请先断开连接再重新登录");
  }
  const content = await userContent(user);
  return { model, content };
}

export async function callChatgpt(input: Awaited<ReturnType<typeof prepareChatgpt>>, options: {
  system: string; json: boolean; maxTokens: number; timeoutMs: number;
}) {
  const started = Date.now();
  let rejection: ProviderRejectedError | undefined;
  let requestId: string | null = null;
  const fetchProvider: typeof fetch = async (url, init) => {
    try {
      const response = await fetch(url, { ...init, redirect: "error" });
      requestId = response.headers.get("x-request-id");
      if (!response.ok) rejection = new ProviderRejectedError(`ChatGPT HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500);
      return response;
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "")) {
        rejection = new ProviderRejectedError("ChatGPT 服务连接失败", null, true);
      }
      throw error;
    }
  };
  const response = await piModels.completeSimple(input.model, {
    systemPrompt: options.system || undefined,
    messages: [{ role: "user", content: input.content, timestamp: started }],
  }, {
    fetch: fetchProvider,
    signal: AbortSignal.timeout(options.timeoutMs),
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
    maxTokens: options.maxTokens,
    transport: "sse",
    reasoning: "low",
    cacheRetention: "none",
    ...(options.json ? { samplingParams: { text: { format: { type: "json_object" } } } } : {}),
  });
  if (rejection) throw rejection;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    // SDK 错误文本可能包含请求细节，不写入日志或回执。
    throw new Error("ChatGPT 请求未完整完成，请查看连接状态与订阅额度；本次结果未知");
  }
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  const usage = { prompt_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
    completion_tokens: response.usage.output, total_tokens: response.usage.totalTokens,
    prompt_tokens_details: { cached_tokens: response.usage.cacheRead }, billing: "subscription" };
  return { response: { choices: [{ message: { content: text }, finish_reason: response.stopReason === "length" ? "length" : "stop" }], usage, _latencyMs: Date.now() - started },
    usage, requestId, cost: null };
}
