// 登录过程只在 API 内存中保留十分钟；正式凭据由 pi-ai 的后端存储保存。
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { AdminChatgpt } from "@aihot/contracts/admin";
import { SITE } from "@aihot/site";
import { chatgptConnection, chatgptHostId, piCredentials, piModels } from "../providers/pi-auth.ts";
import { chatgptModelId } from "../providers/pi-ai.ts";
import { capabilities, capabilityAcceptsModel } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { switchModel } from "./models.ts";
import { audit } from "../audit.ts";

type LoginView = NonNullable<AdminChatgpt["login"]>;
interface LoginSession {
  actor: string;
  view: LoginView;
  abort: AbortController;
  submit?: (value: string) => void;
}
let session: LoginSession | null = null;
const badRequest = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function loginFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return signal.reason?.name === "TimeoutError" ? "登录等待超过十分钟，请重新连接 ChatGPT" : "登录已取消";
  const messages: string[] = [];
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; depth++) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  const detail = messages.join(" ");
  if (/EADDRINUSE|Port 1455 is in use/.test(detail)) return "登录回调端口 1455 已占用，请结束其他登录后重试";
  if (/Credential store modify failed/.test(detail)) return "OpenAI 已返回凭据，但服务器保存失败，请检查数据库和凭据加密配置后重新连接";
  if (/invalid_grant/.test(detail)) return "OpenAI 拒绝了授权码（已过期或已使用），请重新连接 ChatGPT";
  const status = /OpenAI OAuth token request failed \((\d{3})\)/.exec(detail)?.[1];
  if (status) return `浏览器授权已返回，但 OpenAI 凭据交换失败（HTTP ${status}），请重新连接；若持续失败，请检查服务器代理`;
  const field = /invalid (access_token|refresh_token|scope|expires_in)/.exec(detail)?.[1];
  if (field) return `OpenAI 返回的登录凭据缺少有效 ${field}，请重新连接 ChatGPT`;
  if (/did not contain an ID token/.test(detail)) return "OpenAI 未返回身份凭据，请重新连接 ChatGPT";
  if (/grant did not include chatgpt\.tokens\.use\.direct/.test(detail)) return "OpenAI 未授予订阅额度权限，请重新连接并允许使用 ChatGPT 套餐额度";
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|timed out|TimeoutError/.test(detail)) return "服务器未能完成 OpenAI 凭据交换，请检查服务器代理后重新连接";
  return "ChatGPT 连接未完成，请重新连接";
}

export async function chatgptStatus(actor: string): Promise<AdminChatgpt> {
  return { ...await chatgptConnection(), model: chatgptModelId(), login: session?.actor === actor ? { ...session.view } : null };
}

function manualPrompt(current: LoginSession, prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== "manual_code") return Promise.reject(new Error("不支持的 ChatGPT 登录步骤"));
  return new Promise((resolve, reject) => {
    const signal = prompt.signal ?? current.abort.signal;
    if (signal.aborted) return reject(new Error("登录已取消"));
    const subscription = addAbortListener(signal, () => {
      current.submit = undefined;
      reject(new Error("登录已取消"));
    });
    current.submit = (value) => {
      subscription[Symbol.dispose]();
      current.submit = undefined;
      resolve(value);
    };
  });
}

export async function startChatgptLogin(actor: string): Promise<AdminChatgpt> {
  if (session?.view.status === "pending") {
    if (session.actor !== actor) throw badRequest("另一位管理员正在连接 ChatGPT", 409);
    return chatgptStatus(actor);
  }
  const current: LoginSession = { actor, abort: new AbortController(), view: {
    id: randomUUID(), status: "pending", authUrl: null, message: "正在准备登录，请稍候", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  } };
  session = current;
  const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(600_000)]);
  void (async () => {
    try {
      const hostId = await chatgptHostId();
      await piModels.login("openai", "oauth", {
        signal,
        prompt: (prompt) => manualPrompt(current, prompt),
        notify(event) {
          if (event.type === "auth_url") {
            if (new URL(event.url).origin !== "https://auth.openai.com") throw new Error("登录地址不可信");
            current.view.authUrl = event.url;
            current.view.message = "请在 OpenAI 页面登录并允许本项目使用订阅额度";
          } else if (event.type === "progress") current.view.message = "浏览器授权已返回，正在向 OpenAI 换取并保存登录凭据";
        },
      }, { getDeviceId: () => hostId, agentName: SITE.name });
      await audit(actor, "models.chatgpt.connect", "provider:openai", "连接 ChatGPT 订阅", null, { connected: true });
      current.view.status = "success";
      current.view.message = "ChatGPT 已连接，可以将处理步骤切换到 chatgpt";
    } catch (error) {
      current.view.status = current.abort.signal.aborted ? "cancelled" : "error";
      current.view.message = loginFailure(error, signal);
    } finally {
      current.view.authUrl = null;
      current.submit = undefined;
    }
  })();
  return chatgptStatus(actor);
}

export async function submitChatgptCallback(actor: string, id: string, value: string): Promise<AdminChatgpt> {
  if (!session || session.actor !== actor || session.view.id !== id || !session.submit || session.view.status !== "pending") {
    throw badRequest("登录已结束，请重新连接", 409);
  }
  if (value.length > 8192 || !value.startsWith("http://127.0.0.1:1455/auth/callback?")) throw badRequest("请填写浏览器最后跳转的完整本机回调地址");
  session.submit(value.trim());
  return chatgptStatus(actor);
}

export async function cancelChatgptLogin(actor: string): Promise<AdminChatgpt> {
  if (session?.actor === actor && session.view.status === "pending") session.abort.abort();
  return chatgptStatus(actor);
}

export async function disconnectChatgpt(actor: string): Promise<AdminChatgpt> {
  if (session?.view.status === "pending") session.abort.abort();
  await piCredentials.delete("openai");
  await audit(actor, "models.chatgpt.disconnect", "provider:openai", "断开 ChatGPT 订阅", null, { connected: false });
  session = null;
  return chatgptStatus(actor);
}

export async function useChatgpt(actor: string) {
  if (!(await chatgptConnection()).connected) throw badRequest("请先连接 ChatGPT 订阅");
  if (!piModels.getModel("openai", chatgptModelId())) throw badRequest("pi-ai 不支持当前模型，请修改 CHATGPT_MODEL");
  const steps = capabilities();
  if (Object.values(steps).some((step) => !capabilityAcceptsModel(step, MODELS.chatgpt!))) {
    throw badRequest("当前 ChatGPT 模型不支持图片，不能用于所有处理步骤，请修改 CHATGPT_MODEL");
  }
  for (const key of Object.keys(steps)) await switchModel(key, "chatgpt", "使用已连接的 ChatGPT 订阅", actor);
  return { ok: true };
}
