import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";

test("加载模型模块后，授权和模型使用的 fetch 仍经过部署代理", async () => {
  const target = createServer((_request, response) => response.end("代理验证成功"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as { port: number }).port;
  let tunnels = 0;
  let requests = 0;
  const proxy = createServer((_request, response) => {
    requests++;
    response.end("代理验证成功");
  });
  proxy.on("connect", (_request, socket, head) => {
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--use-env-proxy", "--input-type=module", "-e", `
      await import('./packages/backend/src/providers/llm.ts');
      const response = await fetch('http://proxy-check.invalid/check', { signal: AbortSignal.timeout(3000) });
      console.log(await response.text());
    `], { env: { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" }, timeout: 10000 });
    assert.match(stdout, /代理验证成功/);
    assert.equal(tunnels + requests, 1);
  } finally {
    target.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]);
  }
});
