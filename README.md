# OnmyojiAutoScript 文档站

这是 OnmyojiAutoScript 的中文文档站，使用 Starlight 构建，包含用户手册和开发文档。

## 本地开发

```bash
pnpm install
pnpm dev
```

开发服务器默认运行在 `http://localhost:4321/`。构建生产版本： 

```bash
pnpm build
pnpm preview
```

## 本地部署

编译 -> 启动数据库 -> 启动后端 ->启动前端
```bash
$env:TINA_PUBLIC_IS_LOCAL="false"
pnpm install --frozen-lockfile
pnpm build
```

```bash
# 开启
Start-Service MongoDB
# 关闭
Stop-Service MongoDB
# 查看状态
Get-Service MongoDB
```

```bash
$env:TINA_PUBLIC_IS_LOCAL="false"
$env:PORT="4322"
pnpm start
```

后端日志以 JSON 输出到标准输出，默认级别为 `info`。可通过 `LOG_LEVEL=debug|info|warn|error|fatal` 调整级别；每个请求都会返回 `x-request-id`，便于和服务端日志关联。

部署已发布文档时，在对应 Git 版本上完成构建后刷新 Tina 的编辑基准：

```bash
pnpm exec tsx scripts/reindex-main.ts <published-commit>
```

命令先构建和检查新的 MongoDB 索引，随后切换编辑基准。已有草稿保留原来的基准。

新版 Tina 草稿使用 `oas-draft-*` 分支。若旧草稿使用 GitHub 登录名作为分支名，可以先完成已有 PR，或在 GitHub 保留原有改动后通过 Clean 开始新草稿。Clean 会保留这些旧分支和已在 Tina 外修改的分支。

```bash
caddy run --config .\Caddyfile
```

## Cloudflare Workers/Pages + Docker 后端部署

生产环境可以将公开文档部署到 Cloudflare Workers 或 Cloudflare Pages，将 Tina 后端和 MongoDB 部署到自己的服务器。

### 1. Cloudflare Workers

仓库中的 `worker/index.ts` 会把 `/api/tina/*` 和 `/tina-island/*` 转发到后端，其余请求由 Worker 静态资源绑定提供。Worker 必须配置运行时变量 `BACKEND_ORIGIN`，它是后端的公开 origin（只写协议、域名和可选端口，不要写 `/api/tina` 路径），例如：

```text
BACKEND_ORIGIN=https://api.example.com
```

当前阿里云服务器可使用 `http://47.119.160.194.nip.io:4322` 作为临时公网主机名。它要求服务器安全组放行 TCP 4322，生产环境仍建议换成自己的 HTTPS 域名。

如果使用 Wrangler，可以先构建静态资源，再写入 Worker 变量并部署：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dlx wrangler secret put BACKEND_ORIGIN
pnpm dlx wrangler deploy
```

`wrangler secret put` 执行时输入实际的后端 origin。这个值也可以在 Cloudflare Dashboard 的 **Workers & Pages → oas-website → Settings → Variables and Secrets** 中添加为 `BACKEND_ORIGIN`，保存后重新部署 Worker。后端必须能从公网访问，并且要提供 `/api/tina/*` 和 `/tina-island/*`；只监听服务器 `127.0.0.1` 的地址不能直接作为此变量。推荐通过 Caddy 或 Cloudflare Tunnel 暴露 HTTPS 443，再把对应的域名填入 `BACKEND_ORIGIN`，不要填 Worker 自己的 `workers.dev` 地址。

`BACKEND_ORIGIN` 是 Worker 的运行时变量，不是前端构建变量，也不会从后端服务器的 `.env.production` 自动读取。未配置时，Worker 会对上述代理路径返回 `500 BACKEND_ORIGIN is not configured for this Worker`。

### 2. Cloudflare Pages

在 Cloudflare Pages 中配置：

```text
构建命令: pnpm install --frozen-lockfile && pnpm build
输出目录: dist/client
Node.js: 22
```

构建环境至少需要设置：

```env
TINA_PUBLIC_IS_LOCAL=false
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
GITHUB_BRANCH=tina
```

不要在 Cloudflare Pages 中设置 `CLERK_SECRET_KEY`、`MONGODB_URI` 或 GitHub 私密令牌。

由于 Tina 的 API 使用相对路径，Cloudflare Pages 需要将以下路径代理到后端域名。把 `api.example.com` 替换成实际的后端域名，可以将规则保存为 `public/_redirects` 后再构建：

```text
/api/tina/* https://api.example.com/api/tina/:splat 200
/tina-island/* https://api.example.com/tina-island/:splat 200
```

这样浏览器仍然以 Cloudflare Pages 域名访问 Tina，Cookie 和认证请求保持同源。

### 3. Docker 后端

Docker 相关文件都在 [docker/](docker/)：`Dockerfile`、`Dockerfile.frontend`、`docker-compose.yml` 和 Nginx 配置。以下命令都在仓库根目录执行。`.dockerignore` 仍在仓库根目录，因为 Docker 构建上下文是仓库根目录。

先创建生产环境文件：

```bash
cp .env.production.example .env.production
```

填写真实的 Clerk、GitHub 和 MongoDB 配置，然后启动：

```bash
docker compose -f docker/docker-compose.yml --env-file .env.production up -d --build
```

镜像默认从 DaoCloud 的 Docker Hub 代理下载，可以在 `.env.production` 中覆盖：

- `NODE_IMAGE`：Node 基础镜像
- `MONGO_IMAGE`：MongoDB 镜像
- `NGINX_IMAGE`：前端 Nginx 镜像

海外服务器改成 `node:26.13.1-bookworm-slim`、`mongo:8`、`nginx:1.27-alpine` 即可。

默认启动两个容器：

- `backend`：运行 `server.ts`、Tina API 和 Tina island 刷新接口，同时提供构建好的 `dist/client` 前端页面
- `mongo`：保存 Tina 索引、草稿、工作区、锁和限流数据

`backend` 镜像在构建阶段已经执行 `pnpm build`，所以即使不启用独立前端容器，访问 `http://127.0.0.1:4322/` 也能看到前端页面，`/api/tina` 也由同一个容器提供。

另外有一个可选的 `frontend` 容器（Compose profile `frontend`），用 Nginx 单独提供静态页面，并把 `/api/tina`、`/tina-island` 反代到 `backend:4322`。需要独立前端入口时再启用。

2GB 内存的服务器建议在本地或 CI 构建镜像，不要在服务器上直接 `up --build`，否则 Astro/Tina 构建容易 OOM：

```bash
# 本地构建并导出
docker compose -f docker/docker-compose.yml --env-file .env.production build backend
docker save oas-website-backend:latest -o oas-backend.tar

# 上传到服务器后导入并启动
sudo docker load -i oas-backend.tar
docker compose -f docker/docker-compose.yml --env-file .env.production up -d --no-build --force-recreate backend
```

MongoDB 数据保存在 `mongo_data` Volume 中，不会随着后端容器重建而丢失。后端服务监听服务器的 `4322` 端口，Worker 可以通过服务器公网入口转发 `/api/tina/*` 和 `/tina-island/*`。

服务器上的 Caddy 可以参考 [docker/Caddyfile.example](docker/Caddyfile.example)，把 `api.example.com` 反向代理到 `127.0.0.1:4322`。不用 Caddy 时，可以用 Cloudflare Tunnel 把 `api.example.com` 指向 `http://127.0.0.1:4322`。

查看状态和日志：

```bash
docker compose -f docker/docker-compose.yml --env-file .env.production ps
docker compose -f docker/docker-compose.yml --env-file .env.production logs -f backend
```

备份数据库：

```bash
docker compose -f docker/docker-compose.yml --env-file .env.production exec -T mongo mongodump \
  --username "$MONGO_ROOT_USERNAME" \
  --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --db tinacms \
  --archive > tinacms-backup.archive
```

`MONGODB_URI` 中的用户名和密码如果包含 URI 保留字符，需要先进行 URL 编码。生产环境不要提交 `.env.production`。

### 4. Docker 前端（可选）

如果要在服务器上单独部署一个前端容器：

```bash
docker compose -f docker/docker-compose.yml --env-file .env.production --profile frontend build frontend
docker compose -f docker/docker-compose.yml --env-file .env.production --profile frontend up -d --no-build frontend
```

访问 `http://<服务器IP>:4321/`。Nginx 会把 `/api/tina/*` 和 `/tina-island/*` 转发到 `backend:4322`，所以后台登录和 API 与前端同源。需要先在阿里云安全组放行 TCP 4321。

本地构建并导出两个镜像：

```bash
docker compose -f docker/docker-compose.yml --env-file .env.production --profile frontend build backend frontend
docker save oas-website-backend:latest oas-website-frontend:latest -o oas-images.tar
```

服务器导入并启动：

```bash
sudo docker load -i oas-images.tar
docker compose -f docker/docker-compose.yml --env-file .env.production --profile frontend up -d --no-build
```

### 5. 发布后的 Tina 索引

文档合并到 GitHub 并完成 Cloudflare Pages 发布后，在包含对应发布版本的工作区执行：

```bash
pnpm exec tsx scripts/reindex-main.ts <published-commit>
```

这会在 MongoDB 中建立新索引并切换到对应的发布版本。


## 内容结构

- `src/content/docs/user-manual/`：用户手册
- `src/content/docs/development/`：开发文档
- `public/images/`、`public/picture/`：从旧站迁移的图片资源
- `packages/starlight-theme-six/src/overrides/Header.astro`：Six 主题 Header，包含站点导航和主题操作
- `packages/starlight-theme-six/src/overrides/Sidebar.astro`：Six 主题 Sidebar，按文档区域过滤目录

站点配置位于 `astro.config.mjs`，文档侧栏和导航入口都在这里维护。
