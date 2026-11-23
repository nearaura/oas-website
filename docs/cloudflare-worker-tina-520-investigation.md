# Cloudflare Worker 与 Tina 520/522 问题记录

## 记录时间

2026-11-23

## 问题范围

生产站点是 Cloudflare Worker，Node/Tina 后端运行在阿里云服务器的 `4322` 端口。Worker 通过 `BACKEND_ORIGIN` 转发以下路径：

- `/api/tina/*`
- `/tina-island/*`

当前源站地址是 `http://47.119.160.194.nip.io:4322`。

## 用户侧表现

登录 Tina 管理后台后，页面显示：

```text
Unexpected Error
An unexpected error occurred while validating your Tina schema.
```

浏览器网络面板中，主要失败请求是：

```text
POST /api/tina/gql       520
POST /tina-island/docs   520 或 522
```

“schema validation”是 Tina 收不到 GraphQL introspection 响应后的前端表现。它不是当前最初的 schema 配置错误。

## 已复现的对照结果

### `/tina-island/docs`

直接请求后端：

```text
GET  http://47.119.160.194.nip.io:4322/tina-island/docs?...  → 405
POST http://47.119.160.194.nip.io:4322/tina-island/docs?... → 200 HTML
```

GET 返回 405 是后端接口只接受 Tina POST 的正常结果。

同一个 POST 经过 Worker 时出现过：

```text
520 Web server is returning an unknown error
522 Connection timed out
200 HTML
```

因此问题发生在 Worker 到源站的转发链路或源站响应被 Cloudflare 解析的阶段。

### `/api/tina/gql`

直接后端发送无认证 GraphQL 请求：

```text
401 {"error":"User not authorized"}
```

这证明后端 API 可以处理请求并返回正常 HTTP 响应。

在无 Cookie 的隔离浏览器上下文中，Worker 也能稳定返回 401。带登录浏览器上下文的请求则出现 520，说明浏览器 Cookie 和上下文请求头会影响 Worker 到源站的请求结果。

## 根因判断

当前存在两个相互叠加的问题。

### 1. 源站响应格式对 Cloudflare 边缘不稳定

Astro Node 默认对 `/tina-island` 使用 HTML 流式输出。后端直连浏览器可以读取这类响应，但 Cloudflare 在 Worker 转发过程中偶发把它判断为未知或异常源站响应。

Cloudflare 官方对 520 的定义包括源站返回空响应、格式异常响应、响应头过大、连接提前关闭，以及 Cloudflare 无法解析源站响应。官方还特别列出过大的 Cookie 请求头作为常见原因。

### 2. Worker 原样转发了浏览器上下文

Worker 原先复制全部请求头，包含 Cookie、Origin、Referer 和浏览器的 `Sec-Fetch-*` 头部。Tina 登录后请求还会携带 Clerk Cookie 和 Authorization。无 Cookie 请求返回 401，而带浏览器上下文请求返回 520，说明请求头形状参与了故障。

### 3. 520 和 522 的含义不同

520 表示 Cloudflare 收到了无法识别或无法解析的源站响应。522 表示 Cloudflare 与源站建立连接或等待响应时超时。Tunnel 主要针对连接路径和源站暴露方式，不能单独修复 malformed response 或不合适的 Worker 请求头。

## 已提交的修复

- `ab624da` 配置 Worker 的 `BACKEND_ORIGIN`。
- `59b1c3d` 将后端端口绑定到 `0.0.0.0:4322`。
- `9b17b56` 清理 Worker 响应中的 hop-by-hop headers。
- `2555295` 在 Worker 中缓冲代理响应体。
- `45738b3` 对空 Tina island 请求不再转发空流式 body。
- `39674f0` 对 Tina island 使用文本响应、`identity` 编码和最小响应头。
- `9f34ae9` 将 Astro Node 设置为 `experimentalDisableStreaming: true`。这项修改需要重新构建并重启后端容器才会作用于阿里云服务器。
- `0e32b64` 为 Tina island 的瞬时 5xx 增加一次重试。
- `3ec0203` 恢复 Tina API 原始请求体流式转发，撤回会导致 API 520 的请求体缓冲。
- `d0c81ac`、`da517fb` 清理 Tina API 的 Cookie、Origin、Referer 和浏览器上下文头部。`da517fb` 推送时需要等待 Cloudflare 构建完成后再做生产验证。

## 当前结论

Worker 代理仍然是正确的整体架构，Tunnel 不是 Tina 请求的替代入口。Tunnel 可以减少 522 和公网端口暴露，但请求仍然应保持：

```text
浏览器 → Worker → 后端入口 → Node/Tina
```

要彻底消除 520，需要同时满足以下条件：

1. Worker 不把不必要的浏览器 Cookie 和上下文头部转发给 `/api/tina/gql`。
2. 后端完成 `experimentalDisableStreaming: true` 的生产构建并重启。
3. 生产 Worker 构建完成后，用登录状态重新验证 `/api/tina/gql` 的 introspection 请求。
4. 查看 Cloudflare Origin Analytics 或 Worker 日志，将成功的源站状态与边缘返回状态进行对照。

## 复现命令

直接验证后端 Tina island：

```powershell
curl.exe -i --max-time 15 -X POST `
  'http://47.119.160.194.nip.io:4322/tina-island/docs?slug=user-manual%2Fgetting-started' `
  -H 'content-type: application/x-tina-preview+json' `
  --data-binary ''
```

验证 Worker Tina island：

```powershell
curl.exe -i --max-time 30 -X POST `
  'https://oas-website.2917118748.workers.dev/tina-island/docs?slug=user-manual%2Fgetting-started' `
  -H 'content-type: application/x-tina-preview+json' `
  --data-binary ''
```

## 参考资料

- [Cloudflare Error 520 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/)
- [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Tunnel 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
