import { useEffect, useState } from "react";
import type { AdminChatgpt, AdminModels } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { Badge, Button, Card, Field, Input } from "./ui";

export function ChatgptConnection({ initial }: { initial: AdminModels["chatgpt"] }) {
  const [status, setStatus] = useState<AdminChatgpt>({ ...initial, login: null });
  const [callback, setCallback] = useState("");
  const { run, busy } = useAdminAction();
  const waiting = status.login?.status === "pending";

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/admin/chatgpt", { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        if (!response.ok) return;
        const next: AdminChatgpt = await response.json();
        if (abort.signal.aborted) return;
        setStatus(next);
        if (next.login?.status === "pending") timer = setTimeout(poll, 2000);
      } catch {
        if (!abort.signal.aborted && waiting) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [status.login?.id, status.login?.status, waiting]);

  async function command(action: "login" | "callback" | "cancel" | "disconnect") {
    const value = callback;
    if (action === "callback") setCallback("");
    const next = await run<AdminChatgpt>("POST", `/api/admin/chatgpt/${action}`,
      action === "callback" ? { id: status.login?.id, url: value } : {}, { revalidate: false });
    if (next) setStatus(next);
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2">ChatGPT 订阅 <Badge tone={status.connected ? "accent" : "muted"}>{status.connected ? "已连接" : "未连接"}</Badge></span>}>
      <p className="text-sm text-ink-3">登录你的 ChatGPT 账户，让资料筛选、中文摘要和事件归组使用订阅额度。无需填写 API Key，调用会计入你的共享订阅用量。</p>
      <p className="mt-2 text-sm text-ink-3">当前模型：<span className="font-mono">{status.model}</span>。可以在 ChatGPT 的用量设置中限制这个站点的额度。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={busy || waiting} onClick={() => void command("login")}>{status.connected ? "重新连接 ChatGPT" : "连接 ChatGPT"}</Button>
        {status.connected && <>
          <Button disabled={busy || waiting} onClick={() => void run("POST", "/api/admin/chatgpt/use", {}, { success: "所有处理步骤已切换到 ChatGPT，之后的新任务生效" })}>所有处理步骤使用 ChatGPT</Button>
          <Button disabled={busy || waiting} onClick={() => void command("disconnect")}>断开连接</Button>
        </>}
        {waiting && <Button disabled={busy} onClick={() => void command("cancel")}>取消登录</Button>}
      </div>
      {status.login && <p role="status" className={`mt-3 text-sm ${status.login.status === "error" ? "text-hot" : "text-ink-3"}`}>{status.login.message}</p>}
      {waiting && status.login?.authUrl && <div className="mt-3 space-y-3">
        <a className="inline-flex rounded-control bg-accent px-3 py-2 text-sm font-medium text-white" href={status.login.authUrl} target="_blank" rel="noreferrer noopener">打开 OpenAI 登录页面</a>
        <details className="text-sm text-ink-3">
          <summary className="cursor-pointer">登录后没有自动返回？</summary>
          <div className="mt-3 space-y-2">
            <p>把浏览器最后跳转的完整本机地址粘贴在下面。这是一次性授权回调，提交后会清空。</p>
            <Field label="登录回调地址"><Input type="url" autoComplete="off" value={callback} placeholder="http://127.0.0.1:1455/auth/callback?..." onChange={(event) => setCallback(event.target.value)} /></Field>
            <Button disabled={busy || !callback.trim()} onClick={() => void command("callback")}>完成连接</Button>
          </div>
        </details>
      </div>}
    </Card>
  );
}
