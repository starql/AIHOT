# 使用 ChatGPT 订阅

本项目通过 `@earendil-works/pi-ai` 的 OpenAI provider 接入 **Sign in with ChatGPT**，使用 Responses API。它使用你授权的 ChatGPT 额度，不要求 OpenAI API Key，也不在授权失效时自动改用按量付费的 API。是否可用及实际额度由 OpenAI 账户和当前计划决定。

## 连接

1. 更新依赖，重建网页并重启 API、worker 和网页。本次不新增数据库迁移。
2. 在私有后台打开“模型与评测”，点击“连接 ChatGPT”。
3. 点击“打开 OpenAI 登录页面”，由账户本人完成登录和订阅额度授权。
4. 成功后点击“所有处理步骤使用 ChatGPT”，或逐项选择 `chatgpt`。切换只影响之后的新任务。
5. 正式运行前，配置自己的信源，确认 `MODEL_CALLS_ENABLED=true` 与 `COLLECT_ENABLED=true`。开发和测试继续保持关闭；测试只调用本机模拟服务。

订阅模型默认 `gpt-6-luna`，可用 `CHATGPT_MODEL` 修改为 pi-ai OpenAI catalog 中的模型 ID，随后重启 API 和 worker。登录本身不会开启采集，不会改动既有信源、精选标准和条款。

## 本机和远程服务器

OAuth 回调仅监听 `127.0.0.1:1455`，无需开放公网端口。在本机访问后台时可自动返回；后台在远程服务器时，可以同时转发网页和回调端口：

```bash
ssh -N -L 3330:127.0.0.1:3330 -L 1455:127.0.0.1:1455 <服务器>
```

若回调不能自动返回，在后台展开“登录后没有自动返回？”，粘贴浏览器最后跳转的完整 `http://127.0.0.1:1455/auth/callback?...` 地址。该地址含一次性授权码，不发到聊天、日志或公开页面。登录等待十分钟后结束；API 重启会结束未完成的登录，重新连接即可。

pi-ai 的回调页显示 `Authentication successful` 时，只表示已收到浏览器的授权回调。服务器随后还要向 OpenAI 换取并保存凭据；以后台显示“已连接”为完成依据。若后台提示授权码失效、凭据交换失败或保存失败，按提示处理后重新连接，旧回调地址不能重复完成授权。

服务器上的交换请求持续失败时，可采用 OpenAI 官方的[远程 VM 授权流程](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)：在本机用本项目完成 OAuth，把本次授权的凭据通过 SSH 交给服务器加密保存，保留服务器原有的主机标识。使用本项目自己的授权，不读取其他客户端的登录凭据。完成后由服务器负责刷新和模型调用，本机无需持续在线；服务器仍需要可用的 OpenAI 网络连接。

OpenAI 的授权、刷新及模型调用需要能访问 `auth.openai.com` 和 `api.openai.com`。如已有可用的 HTTP 代理，在后端环境中配置 `HTTPS_PROXY` 和 `NO_PROXY=localhost,127.0.0.1,::1`，并给 API 与 worker 的 Node.js 24 启动命令添加 `--use-env-proxy`，例如 `node --use-env-proxy --env-file=.env apps/api/src/main.ts`。代理启用参数必须在 Node 启动时生效，仅在应用 `.env` 中设置 `NODE_USE_ENV_PROXY=1` 不足以启用此处的网络代理。修改后重启 API 和 worker；不要把本机回环代理地址直接搬到远程服务器。

后端检测到 `HTTP_PROXY` 或 `HTTPS_PROXY`（也支持小写变量）时，会显式安装环境代理调度器，并遵守 `NO_PROXY`。这是为了避免 HTTP 库加载后覆盖 Node 启动时的代理，造成普通连接检查成功、实际授权或模型请求却走直连。没有代理变量时保持原有网络设置。

## 凭据与用量

访问与刷新凭据使用 `SESSION_SECRET` 派生的密钥进行 AES-256-GCM 加密，保存在数据库的 `provider-auth.openai` setting 中。前端只读取连接状态；API 与 worker 共用同一密钥和数据库。OAuth 刷新按 provider 在数据库事务内互斥，避免多个进程同时轮换同一 refresh token。

备份需同时保护数据库和 `SESSION_SECRET`。更换此密钥后，请断开旧连接再重新登录。后台“断开连接”清除本项目保存的凭据；要撤销 OpenAI 侧的授权，在 ChatGPT 的登录连接设置里断开该站点。

每次模型请求仍经过现有回执、预算熔断和业务输出校验。首次保存授权时，为 `chatgpt` 初始化每分钟 20、每小时 200、每天 1000 的调用上限；再次登录或刷新不会覆盖管理员已调整的限额。可在后台“设置”中调整。它计的是请求次数，与 OpenAI 的订阅用量上限不同。后台记录 token 与耗时，费用列显示“订阅额度”，不把 API 单价当作订阅账单。SDK 内部自动重试关闭；断流或超时沿用未知回执处理。

参考：[pi-ai 文档](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)、[OpenAI 开源应用订阅授权](https://developers.openai.com/siwc/token-sharing-open-source)、[ChatGPT 应用额度说明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)。
