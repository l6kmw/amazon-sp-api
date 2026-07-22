# Amazon OAuth + SP-API MCP Docker 部署

本方案只容器化 `amazon-oauth-service` 与 `amazon-sp-api-mcp`。TLS、域名、Nginx、Caddy、Traefik、Cloudflare Tunnel 或其他反向代理由部署者自行选择。

## 架构

单个镜像内运行两个独立 Node.js 子进程：

- OAuth：容器端口 `8788`，处理 `/oauth/amazon/*`、`/healthz` 和回环内部连接管理接口；
- MCP：容器端口 `8789`，处理 `/mcp`、`/healthz` 和 `/readyz`。

入口脚本先验证 YAML，启动 OAuth 并等待其健康，然后启动 MCP。任一子进程异常退出时，入口脚本会终止另一个进程并让容器失败重启。Compose 使用 `init: true` 处理子进程回收。

容器以非 root UID/GID `10001` 运行，根文件系统只读、移除所有 Linux capabilities，并且端口默认只绑定宿主机 `127.0.0.1`。

**运行模式**

| 模式 | 用途 | 真相源 |
|---|---|---|
| 文件兼容（file mode） | 本地 / 内部 beta | `/data/tokens.json` 等文件 |
| 生产（production） | ConnectedAccount / 多实例 | **PostgreSQL**（不可丢失状态）+ **Redis**（state/cache/lock） |

文件模式**不是**生产唯一真相源。开启 `connected-account.enabled=true` 时必须配置 `storage.postgres`、`storage.redis` 与 `amazon.credentialKeys`。

Docker **不内置** PostgreSQL/Redis；Compose 示例也不写入真实连接串。外部依赖 URL 只出现在私有 `config.yaml` 或 secret-file 中。

## 首次部署

要求 Docker Engine 和 Docker Compose 插件。

```bash
cp config.example.yaml config.yaml
mkdir -p data
chmod 600 config.yaml
# Linux bind mount 保留数字 UID；配置和数据都必须可由非 root 容器用户访问。
sudo chown 10001:10001 config.yaml
sudo chown -R 10001:10001 data
chmod 700 data
```

编辑 `config.yaml`（Linux 上如已 `chown`，用 `sudoedit` 或改完再 `chown`/`chmod 600`）：

- 公网 HTTPS origin 和 OAuth callback；
- Amazon Application ID、LWA Client ID/Secret；
- 加密 keyring（`amazon.credentialKeys`，生产推荐）或兼容单 key（`tokenEncryptionKey`）；
- 至少 32 字节内部共享密钥（高熵，非 placeholder）；
- 平台允许的 Seller ID；
- 旧实现身份校验 URL；
- 生产：`storage.postgres` / `storage.redis`（url 或 urlFile 二选一）。

生成随机值（只写入私有配置，不进 Git/工单/聊天）：

```bash
openssl rand -base64 32
```

### 唯一镜像 tag 构建与验收

禁止用 `latest` 或未核验的旧缓存镜像作为验收证据：

```bash
IMAGE_TAG="amazon-sp-api:$(git rev-parse --short HEAD)"
export AMAZON_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build --pull
npm run test:docker-image -- "$IMAGE_TAG"
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

超时后应输出脱敏的 compose 状态与最近日志，并清理测试资源。健康后从**宿主机**分别验证（不要只看 container health）：

```bash
curl --fail http://127.0.0.1:8788/healthz
curl --fail http://127.0.0.1:8789/healthz
curl --fail http://127.0.0.1:8789/readyz
```

Compose `healthcheck` 在容器内执行 `node /app/docker/healthcheck.mjs`，同时要求 OAuth `/healthz`、MCP `/healthz` 与 MCP `/readyz` 成功；不依赖 curl/wget。

不要把 OAuth internal 路径代理到公网。外部代理通常只需暴露：

- OAuth：`/oauth/amazon/*`；
- MCP：将公网 MCP 路径代理到 `http://127.0.0.1:8789/mcp`；
- 可选 liveness；**不要公开 `/readyz` 与 `/internal/*`**。

Amazon Portal 中的 OAuth Login URI、Redirect URI 必须与 `amazon.publicOrigin` 和 `amazon.oauthRedirectUri` 完全一致。

## YAML 模型（严格）

仓库只提交 `config.example.yaml`。真实文件为根目录 `config.yaml`（gitignore + dockerignore），只读挂载、权限 **0600**。

### 核心规则

- 未知字段拒绝；错误**只显示字段路径**，不显示配置值；
- 公网 origin / callback 必须 HTTPS；
- JWT / 加密 Secret：base64 或 64-hex，解码后 ≥32 字节；拒绝全零、全相同字节、短周期重复与已知 placeholder；
- `storage.postgres` / `storage.redis`：`url` 与 `urlFile` **互斥**；
- `connected-account.enabled` 默认 `false`；为 `true` 时强制 PostgreSQL、Redis、`credentialKeys`、audience、≥1 JWT key、精确 HTTPS `allowedOrigins`（禁止 `*`）；
- 旧单 key `amazon.tokenEncryptionKey` 仅文件兼容窗口使用，映射为 current `k0`；**不得**在开启 ConnectedAccount 时单独使用。

### 字段与环境映射（摘要）

| YAML | 环境变量（OAuth/MCP） |
|---|---|
| `amazon.lwa.*` | `AMAZON_LWA_CLIENT_ID` / `SECRET` |
| `amazon.credentialKeys` / tokenEncryptionKey | `AMAZON_TOKEN_ENCRYPTION_KEY` + `CURRENT_KEY_ID` + `KEYRING` |
| `storage.postgres.url(File)` | `AMAZON_DATABASE_URL` |
| `storage.redis.url(File)` + namespace | `AMAZON_REDIS_URL` / `AMAZON_REDIS_NAMESPACE` |
| `connected-account.*` | `CONNECTED_ACCOUNT_ENABLED` / `CONNECTED_ACCOUNT_JWT_*` / `CONNECTED_ACCOUNT_ALLOWED_ORIGINS` |
| `mcp.identityValidationUrl` | `LEGACY_IDENTITY_VALIDATION_URL` |
| `mcp.identityHealthUrl` | `LEGACY_IDENTITY_HEALTH_URL`（可选） |
| `oauth.internalSecret` | `AMAZON_INTERNAL_SECRET` |

## Readiness 与 Liveness

| 端点 | 语义 |
|---|---|
| OAuth/MCP `/healthz` | **Liveness**：进程可服务；不因可恢复的外部依赖故障退出进程 |
| MCP `/readyz` | **Readiness**：PostgreSQL、Redis、OAuth 回环、加密 key、identity（legacy 关闭时）等依赖；失败 **503** |

依赖故障注入后 `/readyz` 应在有界时间内变 503；依赖恢复后自动恢复。Liveness 仍按既定语义响应。

## 数据、备份与密钥

### 文件兼容模式

```text
data/
├── tokens.json   # 加密 Refresh Token（兼容/回滚副本）
├── states.json
└── intents.json
```

### 生产模式

- PostgreSQL：OAuth connection、ConnectedAccount Attempt/Grant/Binding/Account、密文；
- Redis：短期 state/intent、Access Token 缓存、LWA 锁；
- `/data` 仍可保留文件回滚副本，但不是生产唯一真相源。

### Schema expand/contract

- 仅 expand（如 `credential_revision`、v2 envelope 双读）；
- **禁止**破坏性 down migration；旧版本读不懂新密文时使用蓝绿/双读。

### 备份

1. 数据库逻辑/物理备份（与业务密钥分离存储）；
2. 加密 keyring / JWT key 材料独立备份（Secret Manager），**不**与 DB 备份同包明文存放；
3. 可选：文件 `tokens.json` 加密归档。

```bash
# 文件模式示例（生产以 DB 备份为准）
docker compose stop amazon-sp-api
tar --numeric-owner -czf /secure/location/amazon-token-store-$(date +%Y%m%dT%H%M%S).tgz data/tokens.json
docker compose start amazon-sp-api
```

恢复后验证：宿主机 `/healthz` + `/readyz`、只读连接检查、密文可解密。

### 轮换

- **JWT**：Provider 双信任新旧 kid → ConnectedAccount 只签发新 key → 等待 ≥ JWT 最大寿命 5 分钟 + 30s → 删除旧 key；
- **加密 key**：expand 双读 → 新写 current key v2 → `rotate-encryption-key.mjs` dry-run → apply 条件更新 → 退役等待 → 再移除旧 key；
- **ConnectedAccount 即时技术回滚**：`connected-account.enabled: false` 后重启容器（不自动删数据）。

## 升级与回滚

```bash
git fetch --all
git checkout <reviewed-commit>
npm ci
npm test
npm run typecheck:mcp
npm run build:mcp
export AMAZON_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build --pull
npm run test:docker-image -- "amazon-sp-api:$AMAZON_IMAGE_TAG"
docker compose up -d --wait --wait-timeout 120
```

回滚：checkout 旧 commit、同一流程 rebuild；Token/密文格式无明确兼容说明时不要覆盖 DB 或 `data/`。

## 身份服务连接

Linux Compose 提供 `host.docker.internal:host-gateway`。远程身份服务必须 HTTPS。生产更推荐受信任 HTTPS 或 mTLS。

## 故障排查

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q amazon-sp-api)"
docker compose logs --tail=200 amazon-sp-api
```

常见问题：

- 配置校验失败：只根据字段路径修正；
- `/readyz` 失败：检查 PostgreSQL/Redis 可达、加密 key、OAuth 回环、identity health；
- OAuth health 未就绪：LWA 凭证或 DB/Redis；
- callback 不匹配：同步 YAML、代理与 Amazon Portal；
- ConnectedAccount 仍关闭：`connected-account.enabled` 默认 false，需 M4 验收与用户解锁后才可开启。
