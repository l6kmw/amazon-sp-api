# Amazon SP-API 部署指南

本文说明如何把本仓库中的 **OAuth 服务 + SP-API MCP** 部署到服务器，并正确接上反向代理与 Amazon 应用配置。

相关文件：

| 文件 | 作用 |
|---|---|
| [`config.example.yaml`](../../config.example.yaml) | 配置模板（可提交 Git） |
| `config.yaml` | **私有配置**（不进 Git，权限 0600） |
| [`docker-compose.yml`](../../docker-compose.yml) | 推荐的 Docker 单容器双进程部署 |
| [`docker/Dockerfile`](../../docker/Dockerfile) | 运行时镜像 |
| 本目录 `DOCKER_DEPLOYMENT.md` | 指向本文（兼容旧链接） |

---

## 1. 你将部署什么

本项目对外提供两类能力：

1. **Amazon OAuth 授权服务**（卖家授权 / 回调 / 连接管理）
2. **Amazon SP-API MCP**（Streamable HTTP MCP，供 Agent 调只读经营数据）

推荐部署形态：**一个 Docker 镜像、一个 Compose 服务、容器内两个 Node 进程**。

```text
                    Internet (HTTPS)
                           │
                    反向代理 / TLS
                    (Nginx / Caddy / …)
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   /oauth/amazon/*   /mcp/amazon      公开 health
   ConnectedAccount 路径*      MCP               (可选)
         │                 │                 │
         ▼                 ▼                 ▼
   127.0.0.1:8788     127.0.0.1:8789    127.0.0.1:878x
   (OAuth 进程)        (MCP 进程)
         │                 │
         └────────┬────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
 PostgreSQL*    Redis*     旧实现身份服务
 (生产真相源)  (锁/缓存)   (Legacy oat_*)
```

\* ConnectedAccount 开启时必填；文件兼容模式可不配 PG/Redis。  
\* ConnectedAccount 路径默认关闭（`connected-account.enabled=false`）。

| 进程 | 容器端口 | 职责 |
|---|---:|---|
| OAuth | **8788** | `/oauth/amazon/*`、OAuth `/healthz`、回环内部连接 API |
| MCP | **8789** | `/mcp`、`/healthz`、`/readyz`、ConnectedAccount `/connected-account/v1/*`（flag 开启时） |

**Compose 只把端口绑到宿主机回环** `127.0.0.1`，不直接暴露公网。TLS 与域名由你方反向代理负责。

---

## 2. 部署前准备

### 2.1 机器与软件

- Linux x86_64 或 arm64 服务器（生产建议独立主机/VM）
- Docker Engine + Docker Compose 插件
- Node.js **≥ 22**（本机构建 / 跑测试时需要；纯镜像部署可不装全局依赖）
- 可写目录用于 `config.yaml` 与 `data/`
- 反向代理能访问 `127.0.0.1:8788` 与 `127.0.0.1:8789`

### 2.2 Amazon 侧

在 [Seller Central / Solution Provider Portal](https://sellercentral.amazon.com/) 准备：

| 项 | 说明 |
|---|---|
| Application ID | SP-API 应用 ID |
| LWA Client ID / Secret | Login with Amazon 凭证 |
| OAuth Redirect URI | 必须与配置里 `amazon.oauthRedirectUri` **完全一致**（含 https、路径、无多余斜杠差异） |
| Authorization / Login URI | 与 `amazon.publicOrigin` 下授权入口一致 |
| 站点区域 | 如欧洲 Seller Central 授权 URI |

示例（欧洲）：

- `publicOrigin`: `https://api.example.com`
- `oauthRedirectUri`: `https://api.example.com/oauth/amazon/callback`
- `authorizationUri`: `https://sellercentral-europe.amazon.com/apps/authorize/consent`

### 2.3 两种运行模式（先选一种）

| 模式 | 适用 | 必填依赖 | 状态真相源 |
|---|---|---|---|
| **文件兼容（file mode）** | 本地调试、内部 beta | 无 PG/Redis | `data/tokens.json` 等 |
| **生产（production）** | 多实例 / 正式运维 / 将来开 ConnectedAccount | **PostgreSQL + Redis** | PostgreSQL；Redis 仅短期 state/cache/lock |

约束：

- 文件模式 **不是** 生产唯一真相源。
- `connected-account.enabled=true` 时 **强制** production 配置：`storage.postgres`、`storage.redis`、`amazon.credentialKeys`、JWT、HTTPS origins。
- **当前默认且建议生产继续：`connected-account.enabled=false`**，直到你方明确解锁外部开放。

---

## 3. 配置文件（最重要）

### 3.1 创建私有配置

```bash
cd /path/to/amazon-sp-api   # 仓库根目录

cp config.example.yaml config.yaml
chmod 600 config.yaml
mkdir -p data
chmod 700 data
```

Linux 上容器以 **UID/GID 10001** 运行，bind mount 必须可被该用户读写：

```bash
sudo chown 10001:10001 config.yaml
sudo chown -R 10001:10001 data
chmod 600 config.yaml
chmod 700 data
```

编辑时若权限导致无法写：`sudoedit config.yaml`，改完再 `chown`/`chmod`。

### 3.2 生成密钥（禁止提交 Git / 聊天 / 工单）

```bash
# 每次生成一个，分别写入不同字段
openssl rand -base64 32
```

至少需要：

1. `oauth.internalSecret`（≥32 字节高熵字符串）
2. `amazon.credentialKeys.keys[].secret` 或兼容字段 `amazon.tokenEncryptionKey`（32 字节，base64 或 64 位 hex）
3. （若开 ConnectedAccount）每个 JWT key 的 secret

Loader 会拒绝：placeholder、全零、全相同字节、短周期重复、长度不足。

### 3.3 必填配置清单

#### 所有模式

| 配置项 | 含义 |
|---|---|
| `amazon.publicOrigin` | 公网 HTTPS Origin，如 `https://api.example.com` |
| `amazon.oauthRedirectUri` | OAuth 回调完整 HTTPS URL，且必须以 publicOrigin 为前缀 |
| `amazon.applicationId` | Amazon Application ID |
| `amazon.authorizationUri` | Seller Central 授权页 |
| `amazon.lwa.clientId` / `clientSecret` | LWA 凭证 |
| `amazon.credentialKeys` **或** `tokenEncryptionKey` | 加密 Refresh Token（二选一） |
| `amazon.allowedSellingPartnerIds` | 平台级卖家硬允许列表（非空） |
| `oauth.internalSecret` | OAuth↔MCP 回环鉴权密钥 |
| `oauth.dataDirectory` | 容器内数据目录，默认 `/data` |
| `mcp.identityValidationUrl` | 旧实现身份校验 URL |
| `server.mcp.allowedHosts` | MCP Host 头允许列表（含公网域名与 localhost） |

#### 生产模式额外

| 配置项 | 含义 |
|---|---|
| `storage.postgres.url` 或 `urlFile` | PostgreSQL 连接（互斥） |
| `storage.redis.url` 或 `urlFile` | Redis 连接（互斥） |
| `storage.redis.namespace` | key 前缀，默认 `amazon-sp-api` |
| `amazon.credentialKeys` | 推荐；含 `currentKeyId` + `keys[]` |

#### ConnectedAccount（默认关闭）

| 配置项 | 含义 |
|---|---|
| `connected-account.enabled` | 默认 `false` |
| `connected-account.audience` | JWT aud |
| `connected-account.allowedOrigins` | 精确 HTTPS Origin 列表，禁止 `*` |
| `connected-account.jwtKeys[]` | `kid` / `issuer` / `secret` 或 `secretFile` |

### 3.4 最小可用示例（文件兼容 / 内部 beta）

```yaml
server:
  oauth:
    host: "0.0.0.0"
    port: 8788
  mcp:
    host: "0.0.0.0"
    port: 8789
    allowedHosts:
      - "api.example.com"
      - "127.0.0.1"
      - "localhost"

amazon:
  publicOrigin: "https://api.example.com"
  oauthRedirectUri: "https://api.example.com/oauth/amazon/callback"
  applicationId: "amzn1.sp.solution.xxxx"
  authorizationUri: "https://sellercentral-europe.amazon.com/apps/authorize/consent"
  applicationVersion: "beta"
  lwa:
    clientId: "amzn1.application-oa2-client.xxxx"
    clientSecret: "<从 openssl 生成或 Portal 获取>"
  credentialKeys:
    currentKeyId: "k0"
    keys:
      - keyId: "k0"
        secret: "<openssl rand -base64 32 的结果>"
  allowedSellingPartnerIds:
    - "A1YOURSELLERID"

oauth:
  internalSecret: "<另一段 openssl rand -base64 32>"
  dataDirectory: "/data"

mcp:
  allowLegacyAuth: false
  enableListingsTools: false
  identityValidationUrl: "http://host.docker.internal:8080/api/v1/admin/session"
  limits:
    requestsPerMinute: 120
    maxConcurrentRequests: 8

connected-account:
  enabled: false
```

### 3.5 生产模式追加示例

在上面基础上增加（真实值只放私有 YAML / secret 文件）：

```yaml
storage:
  postgres:
    # 二选一
    url: "postgresql://amazon:REDACTED@host.docker.internal:5432/amazon"
    # urlFile: "/run/secrets/amazon-database-url"
    schema: "amazon_sp_api"
    pool:
      min: 0
      max: 10
      idleTimeoutMs: 10000
  redis:
    url: "redis://host.docker.internal:6379/0"
    # urlFile: "/run/secrets/amazon-redis-url"
    namespace: "amazon-sp-api"
```

**不要把数据库密码写进 Compose `environment`**，避免 `docker inspect` 泄露。

### 3.6 配置如何进进程

容器入口会：

1. 校验 `config.yaml` 权限（必须 **0600 或更严**，禁止 group/other 可读）
2. 严格 schema 校验（未知字段直接失败，错误只报**字段路径**）
3. 把 YAML 映射为 OAuth / MCP 子进程环境变量后启动

常用映射：

| YAML | 环境变量 |
|---|---|
| `amazon.lwa.clientId/Secret` | `AMAZON_LWA_CLIENT_ID` / `AMAZON_LWA_CLIENT_SECRET` |
| 加密 keyring | `AMAZON_TOKEN_ENCRYPTION_KEY`、`AMAZON_TOKEN_ENCRYPTION_CURRENT_KEY_ID`、`AMAZON_TOKEN_ENCRYPTION_KEYRING` |
| `storage.postgres` | `AMAZON_DATABASE_URL` |
| `storage.redis` | `AMAZON_REDIS_URL`、`AMAZON_REDIS_NAMESPACE` |
| `oauth.internalSecret` | `AMAZON_INTERNAL_SECRET` |
| `mcp.identityValidationUrl` | `LEGACY_IDENTITY_VALIDATION_URL` |
| `connected-account.*` | `CONNECTED_ACCOUNT_ENABLED`、`CONNECTED_ACCOUNT_JWT_*`、`CONNECTED_ACCOUNT_ALLOWED_ORIGINS` |

---

## 4. Docker Compose 部署（推荐）

### 4.1 首次启动（逐步）

在仓库根目录执行。

**步骤 1 — 准备配置与数据目录**（见 §3.1–3.4）

**步骤 2 — 安装依赖并本地门禁（可选但推荐）**

```bash
npm ci
npm --prefix amazon-oauth-service ci
npm --prefix amazon-sp-api-mcp ci
npm test
npm run typecheck:mcp
npm run build:mcp
```

**步骤 3 — 用 commit 级镜像 tag 构建**

验收证据禁止依赖未核验的 `latest`：

```bash
export AMAZON_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build --pull
npm run test:docker-image -- "amazon-sp-api:${AMAZON_IMAGE_TAG}"
```

**步骤 4 — 启动并等待健康**

```bash
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

**步骤 5 — 从宿主机验收端点（不要只看 container healthy）**

```bash
curl -sS --fail http://127.0.0.1:8788/healthz | jq .
curl -sS --fail http://127.0.0.1:8789/healthz | jq .
curl -sS --fail http://127.0.0.1:8789/readyz | jq .
```

期望：

| 端点 | 成功时 |
|---|---|
| OAuth `/healthz` | HTTP 200，`status: "ok"`，`lwaConfigured: true` |
| MCP `/healthz` | HTTP 200，`status: "ok"`，含 tools/version |
| MCP `/readyz` | HTTP 200，`status: "ready"`；依赖失败则为 **503** |

**步骤 6 — 接反向代理与 Amazon Portal**（§5）

### 4.2 日常运维命令

```bash
# 状态 / 日志
docker compose ps
docker compose logs -f --tail=200 amazon-sp-api
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q amazon-sp-api)"

# 重启
docker compose restart amazon-sp-api

# 停机
docker compose stop amazon-sp-api

# 销毁容器（不删 data/ 与 config.yaml）
docker compose down
```

### 4.3 容器安全基线（已内置）

| 项 | 值 |
|---|---|
| 运行用户 | UID/GID **10001** |
| 根文件系统 | **只读** |
| Capabilities | 全部 drop |
| 额外权限 | `no-new-privileges` |
| 配置挂载 | `config.yaml` **read_only** |
| 临时目录 | `/tmp` tmpfs |
| 端口 | 仅 `127.0.0.1:8788/8789` |
| Healthcheck | `node /app/docker/healthcheck.mjs`（OAuth+MCP health + MCP readyz） |

### 4.4 主机端口覆盖

默认：

- OAuth → `127.0.0.1:8788`
- MCP → `127.0.0.1:8789`

可覆盖：

```bash
export AMAZON_OAUTH_PORT=18788
export AMAZON_MCP_PORT=18789
docker compose up -d
```

容器内端口固定 8788/8789，不可改。

---

## 5. 反向代理与公网路径

TLS 终结、证书、HSTS、WAF 由部署者配置。下面以 **Nginx** 为例（仓库内有片段参考：`amazon-sp-api-mcp/api.example.com.nginx`、`amazon-oauth-service/api.example.com.nginx`）。

### 5.1 必须公开的路径

| 公网路径 | 上游 | 说明 |
|---|---|---|
| `/oauth/amazon/` | `http://127.0.0.1:8788` | 授权与回调 |
| `/mcp/amazon` 或你选择的 MCP 路径 | `http://127.0.0.1:8789/mcp` | Streamable HTTP MCP |
| （可选）公网 liveness | MCP 或 OAuth `/healthz` | 仅存活探测 |

若启用 ConnectedAccount（当前默认不启用）：

| 公网路径 | 上游 |
|---|---|
| `/.well-known/connected-account` | `http://127.0.0.1:8789` |
| `/connected-account/v1/` | `http://127.0.0.1:8789` |

### 5.2 禁止公开的路径

| 路径 | 原因 |
|---|---|
| MCP `/readyz` | 暴露依赖拓扑 |
| `/internal/metrics` | 运维指标，仅 loopback |
| OAuth `/internal/*` | 内部连接管理，带 shared secret |

### 5.3 Nginx 最小示例（MCP + OAuth）

```nginx
# OAuth
location /oauth/amazon/ {
    proxy_pass http://127.0.0.1:8788;
    include /etc/nginx/proxy_params;
    proxy_connect_timeout 3s;
    proxy_read_timeout 60s;
}

# 公网 liveness（可选）
location = /healthz/amazon-mcp {
    proxy_pass http://127.0.0.1:8789/healthz;
    include /etc/nginx/proxy_params;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
}

# MCP（Streamable HTTP：关闭缓冲，拉长读超时）
location = /mcp/amazon {
    proxy_pass http://127.0.0.1:8789/mcp;
    include /etc/nginx/proxy_params;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_connect_timeout 3s;
    proxy_read_timeout 300s;
}
```

配置后：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sS --fail https://api.example.com/healthz/amazon-mcp
```

### 5.4 Amazon Portal 对齐检查

部署完成后在 Portal 与 YAML 三方核对：

1. Redirect URI = `amazon.oauthRedirectUri`
2. 应用站点/区域与 `authorizationUri` 一致
3. 允许列表 Seller ID 已写入 `allowedSellingPartnerIds`
4. 浏览器完成一次授权后，MCP 能 `list` 到连接（旧实现路径）

---

## 6. 健康检查语义

| 类型 | 端点 | 失败时 | 含义 |
|---|---|---|---|
| Liveness | OAuth/MCP `/healthz` | 进程应被重启 | 进程能否响应 |
| Readiness | MCP `/readyz` | **HTTP 503**，进程可仍存活 | Token Store / 加密 key / OAuth 回环 / PG / Redis / identity 等 |

运维监控建议：

- 探针存活：`/healthz`（或反代后的公网 liveness）
- 部署验收与内部监控：`/readyz`（**不对公网开放**）

---

## 7. 数据、备份与恢复

### 7.1 文件兼容模式数据布局

宿主机 `./data` → 容器 `/data`：

```text
data/
├── tokens.json    # 加密 Refresh Token + tenant 归属（长期）
├── states.json    # 短期 OAuth state（勿当备份核心）
└── intents.json   # 短期 intent（勿当备份核心）
```

### 7.2 生产模式

| 存储 | 内容 |
|---|---|
| PostgreSQL | OAuth connection、ConnectedAccount 实体、加密 Refresh Token |
| Redis | state/intent、Access Token 缓存、LWA 分布式锁 |
| `/data` | 可选文件回滚副本，非唯一真相源 |

### 7.3 备份原则

1. **数据库备份**与 **加密 keyring / JWT 材料** 分开存放，禁止同包明文密钥。
2. 文件模式至少加密归档 `tokens.json`。
3. 备份介质权限与生产密钥同级管控。

文件模式停机备份示例：

```bash
docker compose stop amazon-sp-api
tar --numeric-owner -czf "/secure/backups/amazon-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" data/tokens.json
# 同时另存一份已加密的 config 密钥材料（不入 tar 明文混存更佳）
docker compose start amazon-sp-api
```

恢复后必须：

```bash
curl --fail http://127.0.0.1:8789/readyz
# 再做一次受控只读：授权列表 / 单次订单或 marketplace 查询
```

### 7.4 密钥轮换（摘要）

- **加密 key**：双读 expand → 新写 current v2 → `amazon-oauth-service/rotate-encryption-key.mjs` dry-run → apply → 退役旧 key。见 M2 实现与计划。
- **JWT**：双 kid 信任 → 只签发新 kid → 等待 ≥ 5 分钟 + 30 秒 → 删旧 kid。见 [jwt-key-rotation-runbook.md](./jwt-key-rotation-runbook.md)。
- **紧急关闭 ConnectedAccount**：`connected-account.enabled: false` 后 `docker compose up -d`（不自动删库）。

---

## 8. 升级与回滚

### 8.1 升级

```bash
git fetch --all
git checkout <已评审 commit>
npm ci
npm --prefix amazon-oauth-service ci
npm --prefix amazon-sp-api-mcp ci
npm test
npm run typecheck:mcp
npm run build:mcp

export AMAZON_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build --pull
npm run test:docker-image -- "amazon-sp-api:${AMAZON_IMAGE_TAG}"
docker compose up -d --wait --wait-timeout 120

curl --fail http://127.0.0.1:8788/healthz
curl --fail http://127.0.0.1:8789/readyz
```

升级前记录：当前 commit、镜像 ID、配置版本、备份位置。

### 8.2 回滚

1. checkout 已知良好 commit  
2. 同一套 build + `test:docker-image` + `up`  
3. **不要**在没有密文兼容说明时覆盖 PostgreSQL 或 `data/tokens.json`  
4. 配置变更用 expand/contract；禁止破坏性 down migration  

---

## 9. systemd 裸机部署（可选，遗留路径）

仓库仍提供单元文件，适合不使用 Docker 的主机：

| 单元 | 路径（仓库内） |
|---|---|
| OAuth | `amazon-oauth-service/amazon-oauth-service.service` |
| MCP | `amazon-sp-api-mcp/amazon-sp-api-mcp.service` |

要点：

1. 将构建产物放到 `/opt/amazon-oauth-service`、`/opt/amazon-sp-api-mcp`
2. 环境文件：`/etc/amazon-oauth-service.env`、`/etc/amazon-sp-api-mcp.env`（及可选 `/etc/amazon-sp-api-storage.env`）
3. 数据目录：`/var/lib/amazon-oauth-service`、`/var/lib/amazon-sp-api-mcp`，权限仅服务用户
4. 监听 `127.0.0.1`，由 Nginx 反代
5. MCP `After=amazon-oauth-service.service`

环境变量集合与 Docker 映射表一致（§3.6）。  
**新环境优先 Docker Compose**，以减少双进程编排与权限差异。

---

## 10. 部署验收清单

### 10.1 启动后（本机）

- [ ] `docker compose ps` 为 healthy / running  
- [ ] `curl --fail 127.0.0.1:8788/healthz`  
- [ ] `curl --fail 127.0.0.1:8789/healthz`  
- [ ] `curl --fail 127.0.0.1:8789/readyz`  
- [ ] 日志无 Secret / Refresh Token / JWT 明文  

### 10.2 公网与 Amazon

- [ ] HTTPS 证书有效  
- [ ] Portal Redirect URI 与 YAML 一致  
- [ ] 完成一次卖家授权回调  
- [ ] MCP 能列出连接并完成一次只读调用（marketplace / 订单抽样）  
- [ ] 断开与重新授权（若使用旧实现连接管理工具）符合预期  

### 10.3 安全

- [ ] `config.yaml` 0600，未进 Git  
- [ ] 未公开 `/readyz`、`/internal/*`  
- [ ] `allowLegacyAuth: false`（生产）  
- [ ] `connected-account.enabled: false`（未解锁前）  
- [ ] 备份与密钥分存  

### 10.4 可选自动化

```bash
# 本地/CI 门禁（不含强制镜像时）
npm run ci-gate

# 带 JWT 的只读契约（服务已对公网或本机可达时）
export CONNECTED_ACCOUNT_JWT='<short-lived-jwt>'   # 仅 ConnectedAccount 开启时需要鉴权段
python3 scripts/verify_connected-account_account_mcp.py --base-url https://api.example.com
# ConnectedAccount 关闭时脚本仅能检查 discovery（可能 404）与 health，属预期
```

---

## 11. 故障排查

| 现象 | 排查 |
|---|---|
| 容器启动即退出 | `docker compose logs`；多半是 `config.yaml` 校验失败——只按字段路径改，无值回显 |
| `config permissions` | `chmod 600 config.yaml` 且 owner 可被 10001 读 |
| `/readyz` 503 | PG/Redis 连通、加密 key、OAuth 回环、identity health、tokens 文件权限 |
| OAuth health `lwaConfigured: false` | LWA clientId/secret 未进配置 |
| 授权回调 400 | state 过期/重放、Origin 不在允许列表、Redirect URI 不一致 |
| MCP 鉴权失败 | 旧实现 `identityValidationUrl` 不可达；Host 不在 `allowedHosts` |
| 回调成功但读不到卖家 | Seller 未进 `allowedSellingPartnerIds` 或 tenant 不匹配 |
| Listings 工具不存在 | `mcp.enableListingsTools` 需为 true 并重建/重启 |
| metrics 404 | 正常：非 loopback 访问 `/internal/metrics` 应 404 |

日志：

```bash
docker compose logs --tail=300 amazon-sp-api
```

结构化日志为 JSON 行；字段已白名单，不应出现 Token。指标见 [alerts-runbook.md](./alerts-runbook.md)。

---

## 12. 架构与安全边界（部署者必读）

1. **公网只走 HTTPS 反代**；应用只听本机回环。  
2. **Refresh Token 仅密文存储**；密钥不进镜像层、不进 Git。  
3. **内部 secret** 仅用于容器内 OAuth↔MCP 回环，不得当用户凭证。  
4. **principal 不可由客户端参数覆盖**；ConnectedAccount 用 JWT，旧实现用身份服务。  
5. **未解锁前禁止** `connected-account.enabled=true` 对外部放量。  
6. 生产多实例必须 PG+Redis，禁止多副本共享可写文件 Token Store。  

---

## 13. 相关文档

| 文档 | 说明 |
|---|---|
| [Amazon-SP-API管理.md](./Amazon-SP-API管理.md) | Portal、角色、上线清单 |
| [jwt-key-rotation-runbook.md](./jwt-key-rotation-runbook.md) | JWT 双 key 轮换 |
| [alerts-runbook.md](./alerts-runbook.md) | 指标与告警 |
| [../connected-account/connected-account-account-mcp-design-spec.md](../connected-account/connected-account-account-mcp-design-spec.md) | ConnectedAccount 设计规格 |
| [../acceptance/](../acceptance/) | 验收证据 |
| [../README.md](../README.md) | 文档总目录 |
