# Tina 部署问题变更记录

## 记录范围

本文件记录 2026-11-23 至 2026-11-24 对 Cloudflare Worker、Node/Astro 后端和生产部署的修改。每次后续修改都要补充原因、验证结果和部署版本。

## 已完成修改

| 时间 | 修改 | 修改原因 | 验证结果 |
| --- | --- | --- | --- |
| 23:44 | Worker 将请求体从一次性流缓冲为 `ArrayBuffer` | Cloudflare 转发大 GraphQL 请求时，直接复用请求流可能导致源站收到不完整请求或重试无法复用 body | 本地模拟确认重试时两次请求都收到完整 body。生产匿名大请求可返回 401 |
| 23:53 | Tina API 和 island 请求使用 `accept-encoding: identity` | 排除源站压缩响应与 Worker 缓冲响应体之间的编码不一致 | 生产 island 多数返回 200，但认证请求仍失败 |
| 00:08 | 尝试只转发 `tina_clerk_token` Cookie，移除 `Authorization` | 试图区分认证头转发与源站认证逻辑 | 直连源站可认证，Worker Cookie-only 请求返回 401，方案已撤回 |
| 00:11 | Worker 5xx 重试从 1 次增加到最多 3 次 | 生产 island 存在瞬时 520/522 | 偶发错误减少，但没有消除认证请求问题 |
| 00:23 | Worker 不再转发旧的请求 `content-length` | 让 Worker 根据缓冲后的 body 重新计算请求长度 | 认证请求仍失败 |
| 00:48 | Worker 响应移除 `content-length` 和 `content-encoding` | 后端日志显示 GraphQL 已返回 200，怀疑 Worker 重建响应时保留源站响应长度或编码头造成 520 | 部署后仍需继续验证，尚未确认解决 |
| 00:53 | 恢复 Tina API 的 `Authorization` 转发，撤回 Cookie-only 方案 | Cookie-only 直连 Worker 返回 401，后端认证需要原始 Authorization 链路 | 当前 Worker 恢复 Authorization 转发 |
| 01:40 | 移除后端为 Tina 响应强制设置 `Connection: close` 的中间件 | 生产复现表明认证 GraphQL 在源站日志中是 200，但经 Worker 仍是 520。直连响应为 `Connection: close` + chunked，Cloudflare 在读取认证响应时仍判定源站连接异常 | 已随 WSL 构建的后端产物部署，文章编辑链路验证通过 |
| 01:55 | 尝试将 Worker 的 `BACKEND_ORIGIN` 从 `nip.io` 主机名改为同一服务器的公网 IP | Worker 日志显示脚本本身没有异常，认证请求的 520/522 是边缘到 HTTP 源站这一跳产生。使用 IP 作为源站地址，排除 nip.io 主机名在 Cloudflare 回源路径中的额外解析差异 | Cloudflare 返回 403 / error code 1003，拒绝 Worker 直接回源到 IP，已恢复 `nip.io` 配置 |
| 02:02 | Worker 改用服务器新建的 HTTPS quick tunnel 作为 `BACKEND_ORIGIN` | Worker 到公开 HTTP `nip.io:4322` 的 fetch 本身返回 Cloudflare 520，服务器虽记录 200，但 Worker 拿不到源站响应。HTTPS Tunnel 可直接把请求送到服务器本地 4322，并避开这条失败的 HTTP 回源路径 | Tunnel 的匿名 GraphQL 返回 401，Tina island 返回 200。Worker 认证 GraphQL、文章列表和文章 island 均返回 200 |
| 02:07 | 在 WSL 的 Linux 文件系统重新执行 `pnpm build`，上传 `dist` 并重启 backend | `/mnt/d` 上的 WSL 安装遇到 Windows 文件权限错误，改用 `/home/neptine/oas-build` 完整安装依赖和构建，再上传生成的 37 MB `dist` | 构建成功。重启后管理后台文章标题、正文、预览、工作区和 PR 状态均正常，相关请求全部 200 |

## 服务器端修改

| 修改 | 原因 | 结果 |
| --- | --- | --- |
| 服务器 `astro.config.mjs` 增加 `experimentalDisableStreaming: true` | 服务器实际运行的配置仍是 `adapter: node({ mode: 'middleware' })`。后端日志出现 Tina island 请求长时间 aborted，认证 GraphQL 在 Node 内部已完成 200 | 已在服务器容器中本地构建生成的 `dist` 上传并重启 backend。服务器构建命令已中止，未继续消耗服务器资源 |
| WSL `pnpm build` 生成 `dist` 并上传到 `oas-website-backend-1:/app/dist/` | 服务器 Docker build 无法完成，且 `/mnt/d` 上的 WSL 安装遇到 Windows 文件权限错误，改用 WSL Linux 文件系统构建 | `/home/neptine/oas-build` 构建成功，上传 37 MB dist，容器已重启 |
| 服务器 `server.ts` 曾为 Tina API/island 响应设置 `Connection: close` | 当时怀疑 Cloudflare 到 HTTP 源站的响应连接解析不稳定 | 已确认该改动没有解决认证请求，当前撤回，避免强制关闭源站连接 |
| `cloudflared` 服务改用 `http2` 协议 | 服务器原 Tunnel 日志持续出现 QUIC stream timeout，先降低 Tunnel 传输层的不稳定因素 | 托管 Tunnel 通过 HTTP/2 预检并保持 Healthy。Worker 当前使用单独启动的 HTTPS quick tunnel 入口 |

## 生产部署版本

| Worker 版本 | 说明 |
| --- | --- |
| `98b9faa6-e1b4-4507-a560-bf8242df7521` | 请求体缓冲版本 |
| `68acd5b8-8eb4-46c6-af59-627f4b8617e7` | identity 编码版本 |
| `3ac9a7d7-9f3f-4e49-9d91-9cc328a320ac` | Cookie-only 认证尝试版本 |
| `1c184294-15d2-42ad-857c-dfe4a0194d30` | 三次重试版本 |
| `f57300a4-158c-495a-aff6-d61211dffb1a` | 删除请求 content-length 版本 |
| `1e3140f1-9c0b-4ec1-a3bb-de2e2c5ce29c` | 删除响应长度和编码头版本 |
| `3527157a-cad0-4ff6-90b0-465adeebab61` | 恢复 Authorization 转发版本 |
| `129baa4a-fe71-4aaf-b82f-8de572ab5569` | HTTPS quick tunnel 源站版本，移除临时诊断日志 |

## 关键证据

- 直连 `http://47.119.160.194.nip.io:4322` 的认证 GraphQL 请求能返回 200。
- 服务器日志记录认证 `/api/tina/gql` 已返回 200，包含 `userId` 和 `githubLogin`。
- Worker 转发到公开 HTTP `nip.io` 源站时，Worker fetch 本身收到 Cloudflare 520 页面，虽然后端日志记录了对应请求 200。
- 认证 GraphQL 的源站日志为 200，但 Worker 仍返回 520/522。加入 `Connection: close` 后问题仍可稳定复现，原先的成功判断不成立。
- 服务器端 Docker build 未执行。后端使用 WSL Linux 文件系统完成 `pnpm build`，生成的 `dist` 已上传到服务器容器。
- 未登录 Worker GraphQL 请求稳定返回 401。
- 正确 `application/x-tina-preview+json` 的 island 直连和 Worker 请求可返回 200。

## 当前状态

- 本地分支比远程多 9 个提交，尚未推送。
- 工作区需要保留本文件作为本轮变更记录。
- Worker 使用 HTTPS quick tunnel 后，匿名 GraphQL 返回 401，登录态 GraphQL、文章列表、`docsTitle` 和 `docs` island 全部返回 200。文章编辑页显示 GitHub 已授权、草稿工作区和可用的 PR 按钮。下一次修改前先更新本记录，再进行单一、可回滚的改动。
- 当前 `BACKEND_ORIGIN` 是 `launches-tourism-entrepreneur-contributing.trycloudflare.com`。它由服务器上的 quick tunnel 进程提供，服务器重启后需要重新启动该进程并同步更新 Worker 变量。
