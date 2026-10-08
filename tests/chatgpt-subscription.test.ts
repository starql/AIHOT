import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, mock, test } from "node:test";
import { z } from "zod";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { AuthInteraction, AuthType, OAuthCredential } from "@earendil-works/pi-ai";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { chatgptConnection, piCredentials, piModels } from "@aihot/backend/providers/pi-auth";
import { BudgetExceededError, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { chatgptStatus, startChatgptLogin, submitChatgptCallback, useChatgpt, disconnectChatgpt } from "@aihot/backend/admin/chatgpt";
import { modelsOverview } from "@aihot/backend/admin/models";

const token: OAuthCredential = { type: "oauth", access: "local-access-never-real", refresh: "local-refresh-never-real", expires: Date.now() + 3600_000, clientId: "local-client", scopes: ["chatgpt.tokens.use.direct"] };
let mode: "ok" | "invalid" | "rate" | "broken" = "ok";
let hits = 0;
let lastRequest: Record<string, unknown> = {};
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  hits++;
  lastRequest = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(request.headers.authorization, `Bearer ${token.access}`);
  if (mode === "rate") { response.writeHead(429, { "content-type": "application/json" }); response.end('{"error":{"message":"local rate limit"}}'); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (data: object) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  const text = mode === "invalid" ? '{"ok":"wrong type"}' : '{"ok":true}';
  emit({ type: "response.created", response: { id: "local-response", model: "gpt-6-luna", status: "in_progress", output: [] } });
  emit({ type: "response.output_item.added", output_index: 0, item: { id: "local-message", type: "message", role: "assistant", content: [], status: "in_progress" } });
  emit({ type: "response.content_part.added", item_id: "local-message", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  emit({ type: "response.output_text.delta", item_id: "local-message", output_index: 0, content_index: 0, delta: text });
  if (mode === "broken") { setTimeout(() => response.destroy(), 15); return; }
  emit({ type: "response.completed", response: { id: "local-response", model: "gpt-6-luna", status: "completed", output: [], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const realProvider = openaiProvider();
const catalogModel = realProvider.getModels().find((model) => model.id === "gpt-6-luna")!;
piModels.setProvider({ ...realProvider, getModels: () => [{ ...catalogModel, baseUrl: `http://127.0.0.1:${address.port}/v1` }] });
process.env.CHATGPT_MODEL = "gpt-6-luna";

const ask = (subject: string, extra = {}) => chatJson({ model: "chatgpt", purpose: "score_article", subject, promptVersion: "local-v1", system: "仅返回 JSON", user: `local ${subject}`, schema: z.object({ ok: z.boolean() }), timeoutMs: 2000, ...extra });
const save = () => piCredentials.modify("openai", async () => ({ ...token }));
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeDb(); });

test("订阅入口没有授权时拒绝调用，不回退到环境里的 API Key", async () => {
  process.env.OPENAI_API_KEY = "never-use-this-api-key";
  assert.equal(await piModels.getAuth("openai"), undefined);
  await assert.rejects(ask(randomUUID()), /先在后台连接 ChatGPT/);
  assert.equal(hits, 0);
});

test("凭据加密保存，状态接口只返回连接状态，多个写入互斥", async () => {
  await save();
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'provider-auth.openai'`;
  assert.ok(!JSON.stringify(row!.value).includes(token.access));
  assert.ok(!JSON.stringify(row!.value).includes(token.refresh));
  await Promise.all(Array.from({ length: 4 }, () => piCredentials.modify("openai", async (current) => {
    const credential = current as OAuthCredential;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ...credential, counter: Number(credential.counter ?? 0) + 1 };
  })));
  assert.equal((await piCredentials.read("openai") as OAuthCredential).counter, 4);
  const status = await chatgptStatus("test-admin");
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes(token.access));
  assert.ok(!JSON.stringify(status).includes(token.refresh));
});

test("两个运行实例同时遇到过期授权，只刷新一次", async () => {
  await piCredentials.modify("openai", async () => ({ ...token, expires: 0 }));
  let refreshes = 0;
  const provider = { ...realProvider, auth: { ...realProvider.auth, oauth: { ...realProvider.auth!.oauth!, refresh: async () => {
    refreshes++; await new Promise((resolve) => setTimeout(resolve, 20)); return { ...token };
  } } } };
  const clients = Array.from({ length: 2 }, () => { const client = createModels({ credentials: piCredentials }); client.setProvider(provider); return client; });
  const results = await Promise.all(clients.map((client) => client.getAuth("openai")));
  assert.equal(refreshes, 1);
  assert.ok(results.every((result) => result?.source === "OAuth"));
});

test("刷新已返回时即使请求取消，也保存轮换后的凭据", async () => {
  const abort = new AbortController();
  await piCredentials.modify("openai", async () => {
    abort.abort();
    return { ...token, refresh: "local-rotated-refresh" };
  }, { signal: abort.signal });
  assert.equal((await piCredentials.read("openai") as OAuthCredential).refresh, "local-rotated-refresh");
  await save();
});

test("真实 pi-ai Responses 适配器调用本地服务，保存回执并复用结果", async () => {
  const subject = randomUUID();
  const before = hits;
  const first = await ask(subject);
  const second = await ask(subject);
  assert.deepEqual(first.data, { ok: true });
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.reused, true);
  assert.equal(hits, before + 1);
  assert.equal(lastRequest.model, "gpt-6-luna");
  assert.equal(lastRequest.stream, true);
  assert.equal(lastRequest.store, false);
  assert.equal(first.usage?.prompt_tokens, 11);
  assert.equal(first.usage?.completion_tokens, 7);
  const [receipt] = await sql<{ service: string; cost: number | null }[]>`SELECT service, cost FROM receipts WHERE id = ${first.receiptId}`;
  assert.equal(receipt!.service, "chatgpt");
  assert.equal(receipt!.cost, null);
  const overview = await modelsOverview();
  const usage = overview.capabilities.flatMap((capability) => capability.usage);
  assert.ok(overview.choices.some((choice) => choice.key === "chatgpt"));
  assert.ok(usage.some((item) => item.subscription === true && item.tokensIn === 11 && item.estimate === null));
});

test("非法业务输出记录为失败，429 不在 SDK 内重试，断流保留未知回执", async () => {
  mode = "invalid";
  await assert.rejects(ask(randomUUID()), ModelOutputError);
  mode = "rate";
  const before = hits;
  await assert.rejects(ask(randomUUID()), (error: unknown) => error instanceof ProviderRejectedError && error.status === 429);
  assert.equal(hits, before + 1);
  mode = "broken";
  const subject = randomUUID();
  await assert.rejects(ask(subject), ReceiptUnknownError);
  const afterBroken = hits;
  await assert.rejects(ask(subject), ReceiptUnknownError);
  assert.equal(hits, afterBroken);
  mode = "ok";
});

test("登录交互绑定管理员，授权后可以选择所有步骤，断开会清除凭据", async () => {
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => { ready = resolve; });
  const login = mock.method(piModels, "login", async (_provider: string, _type: AuthType, interaction: AuthInteraction) => {
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/api/accounts/authorize?state=local" });
    const input = interaction.prompt({ type: "manual_code", message: "local", signal: interaction.signal });
    ready();
    await input;
    await save();
    return token;
  });
  try {
    const started = await startChatgptLogin("owner");
    await waiting;
    assert.equal((await chatgptStatus("other-admin")).login, null);
    await assert.rejects(submitChatgptCallback("other-admin", started.login!.id, "http://127.0.0.1:1455/auth/callback?code=local&state=local"), /登录已结束/);
    await submitChatgptCallback("owner", started.login!.id, "http://127.0.0.1:1455/auth/callback?code=local&state=local");
    for (let i = 0; i < 100 && (await chatgptStatus("owner")).login?.status === "pending"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await chatgptStatus("owner")).login?.status, "success");
    process.env.CHATGPT_MODEL = "unknown-text-model";
    await assert.rejects(useChatgpt("owner"), /pi-ai 不支持当前模型/);
    const [unchanged] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM settings WHERE key LIKE 'models.%'`;
    assert.equal(unchanged!.count, 0);
    process.env.CHATGPT_MODEL = "gpt-6-luna";
    await useChatgpt("owner");
    const rows = await sql<{ value: { model: string } }[]>`SELECT value FROM settings WHERE key LIKE 'models.%'`;
    assert.ok(rows.length >= 10 && rows.every((row) => row.value.model === "chatgpt"));
    await disconnectChatgpt("owner");
    assert.equal((await chatgptConnection()).connected, false);
  } finally { process.env.CHATGPT_MODEL = "gpt-6-luna"; login.mock.restore(); }
});

test("订阅调用不会绕过预算熔断", async () => {
  await save();
  await sql`UPDATE budgets SET per_minute = 0 WHERE service = 'chatgpt'`;
  const before = hits;
  await assert.rejects(ask(randomUUID()), BudgetExceededError);
  assert.equal(hits, before);
});

test("浏览器回调成功后凭据交换仍可能失败，后台区分失败原因且不回显授权内容", async () => {
  const secret = "never-expose-this-authorization-code";
  let failure = new Error(`OpenAI OAuth token request failed (400): {\"error\":\"invalid_grant\",\"code\":\"${secret}\",\"redirect_uri\":\"http://127.0.0.1:1455/auth/callback\"}`);
  const login = mock.method(piModels, "login", async () => { throw failure; });
  try {
    for (const [error, expected] of [
      [failure, /授权码（已过期或已使用）/],
      [new Error(`OpenAI OAuth token request failed (403): ${secret}`), /HTTP 403/],
      [new Error(`OpenAI OAuth token response has invalid expires_in ${secret}`), /expires_in/],
      [new Error("Credential store modify failed for openai", { cause: new Error(secret) }), /服务器保存失败/],
    ] as const) {
      failure = error;
      const started = await startChatgptLogin("owner");
      for (let i = 0; i < 100 && (await chatgptStatus("owner")).login?.status === "pending"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await chatgptStatus("owner");
      assert.equal(status.login?.id, started.login?.id);
      assert.equal(status.login?.status, "error");
      assert.match(status.login!.message, expected);
      assert.ok(!JSON.stringify(status).includes(secret));
    }
  } finally { login.mock.restore(); }
});
