// ChatGPT 凭据只在后端解密；刷新在数据库事务内互斥，避免多个进程重复轮换 refresh token。
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential, CredentialStore, AuthOperationOptions } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { credential } from "../config.ts";
import { sql, type Db } from "../db.ts";

const PREFIX = "provider-auth.";
// HTTP 库加载时可能覆盖 Node 的环境代理；授权、刷新和模型请求统一恢复部署的代理设置。
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

interface StoredAuth { type: Credential["type"]; expires: number | null; encrypted: string }

function encryptionKey(): Buffer {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret || secret.length < 16) throw new Error("保存 ChatGPT 登录需要至少 16 位的 SESSION_SECRET");
  return createHash("sha256").update(`pi-auth:${secret}`).digest();
}

function encode(providerId: string, value: Credential): StoredAuth {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(providerId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { type: value.type, expires: value.type === "oauth" ? value.expires : null,
    encrypted: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64") };
}

function decode(providerId: string, value: StoredAuth): Credential {
  try {
    const bytes = Buffer.from(value.encrypted, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(providerId));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Credential;
  } catch {
    throw new Error("ChatGPT 登录凭据无法解密，请先断开连接再重新登录");
  }
}

async function stored(db: Db, providerId: string): Promise<StoredAuth | undefined> {
  const [row] = await db<{ value: StoredAuth }[]>`SELECT value FROM settings WHERE key = ${PREFIX + providerId}`;
  return row?.value;
}

const check = (options?: AuthOperationOptions) => options?.signal?.throwIfAborted();

export const piCredentials: CredentialStore = {
  async read(providerId, options) {
    check(options);
    const value = await stored(sql, providerId);
    check(options);
    return value ? decode(providerId, value) : undefined;
  },
  async list(options) {
    check(options);
    const rows = await sql<{ key: string; value: Pick<StoredAuth, "type"> }[]>`
      SELECT key, jsonb_build_object('type', value->>'type') AS value FROM settings WHERE key LIKE ${PREFIX + "%"}`;
    return rows.map((row) => ({ providerId: row.key.slice(PREFIX.length), type: row.value.type }));
  },
  async modify(providerId, fn, options) {
    check(options);
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${PREFIX + providerId}))`;
      check(options);
      const value = await stored(tx, providerId);
      const current = value ? decode(providerId, value) : undefined;
      const next = await fn(current);
      // 已收到轮换后的 token 就必须写回，避免取消恰好发生在轮换与提交之间时丢失新凭据。
      if (next) {
        const saved = encode(providerId, next);
        await tx`INSERT INTO settings (key, value, updated_by) VALUES (${PREFIX + providerId}, ${tx.json(saved as never)}, 'chatgpt-auth')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        if (providerId === "openai") await tx`INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
          VALUES ('chatgpt', 20, 200, 1000, 'ChatGPT 订阅调用上限；实际可用额度由 OpenAI 账户决定') ON CONFLICT (service) DO NOTHING`;
      }
      return next ?? current;
    }) as Credential | undefined;
  },
  async delete(providerId, options) {
    check(options);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${PREFIX + providerId}))`;
      check(options);
      await tx`DELETE FROM settings WHERE key = ${PREFIX + providerId}`;
    });
  },
};

export const piModels = createModels({
  credentials: piCredentials,
  // 订阅入口只接受本项目的 OAuth，不从环境变量回退到按量付费的 API Key。
  authContext: { env: async () => undefined, fileExists: async () => false },
});
piModels.setProvider(openaiProvider());

export async function chatgptConnection(): Promise<{ connected: boolean; expiresAt: string | null }> {
  const value = await stored(sql, "openai");
  return { connected: value?.type === "oauth", expiresAt: value?.expires ? new Date(value.expires).toISOString() : null };
}

export async function chatgptHostId(): Promise<string> {
  const key = "chatgpt.host-id";
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json({ id: randomUUID() })}, 'chatgpt-auth') ON CONFLICT DO NOTHING`;
  const [row] = await sql<{ value: { id: string } }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row!.value.id;
}
