# Amazon SP-API（OAuth + MCP）

卖家授权与 Amazon Selling Partner API 只读能力：独立 OAuth 服务 + Streamable HTTP MCP。  
适合旧实现 Agent 连接管理，以及（可选）ConnectedAccount Connected Account Protocol 接入。

**状态：** 内部 / 生产草稿 beta 可用 · `CONNECTED_ACCOUNT_ENABLED` 默认 **关闭** · 未对外部卖家开放

---

## 做什么

| 组件 | 端口（本机） | 作用 |
|---|---:|---|
| OAuth | `127.0.0.1:8788` | 卖家授权、回调、连接管理 |
| MCP | `127.0.0.1:8789` | 订单 / 库存 / Marketplace 等只读工具 |

推荐：**Docker 单容器双进程**，TLS 由外部 Nginx 等反代终结。

```text
Internet (HTTPS) → 反向代理 → 127.0.0.1:8788 / 8789 → OAuth + MCP
```

---

## 仓库结构

```text
amazon-oauth-service/   # OAuth 服务
amazon-sp-api-mcp/      # MCP 服务
docker/                 # 镜像、配置加载、健康检查
docs/                   # 全部文档（计划 / 部署 / 验收）
config.example.yaml     # 配置模板
docker-compose.yml      # 推荐部署方式
scripts/                # 验收脚本与 CI 门禁
```

文档总目录：[`docs/README.md`](docs/README.md)  
完整部署说明：[`docs/operations/DEPLOYMENT.md`](docs/operations/DEPLOYMENT.md)

---

## 快速部署（Docker）

### 1. 准备配置

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
mkdir -p data && chmod 700 data

# Linux 容器用户 UID 10001
sudo chown 10001:10001 config.yaml
sudo chown -R 10001:10001 data
```

编辑 `config.yaml`，至少填写：

- `amazon.publicOrigin` / `oauthRedirectUri`（**HTTPS**，与 Amazon Portal 一致）
- `amazon.applicationId`、`lwa.clientId` / `clientSecret`
- `amazon.credentialKeys`（或兼容字段 `tokenEncryptionKey`）
- `oauth.internalSecret`（≥32 字节随机串）
- `amazon.allowedSellingPartnerIds`
- `mcp.identityValidationUrl`（旧实现身份校验）

生成密钥：

```bash
openssl rand -base64 32
```

生产多实例再配 `storage.postgres` + `storage.redis`。  
**未解锁前保持 `connected-account.enabled: false`。**

### 2. 构建并启动

```bash
export AMAZON_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build --pull
npm run test:docker-image -- "amazon-sp-api:${AMAZON_IMAGE_TAG}"   # 可选但推荐
docker compose up -d --wait --wait-timeout 120
```

### 3. 验收

```bash
curl -sS --fail http://127.0.0.1:8788/healthz
curl -sS --fail http://127.0.0.1:8789/healthz
curl -sS --fail http://127.0.0.1:8789/readyz
```

### 4. 反代（公网）

| 公网路径 | 上游 | 说明 |
|---|---|---|
| `/oauth/amazon/` | `http://127.0.0.1:8788` | 授权与回调 |
| `/mcp/amazon` | `http://127.0.0.1:8789/mcp` | MCP |
| 可选 liveness | `.../healthz` | 存活探测 |

**不要**对公网暴露：`/readyz`、`/internal/*`、OAuth 内部接口。

Amazon Portal 的 Redirect URI 必须与 `amazon.oauthRedirectUri` 完全一致。

更细的 Nginx 示例、备份、升级回滚见 [部署指南](docs/operations/DEPLOYMENT.md)。

---

## 本地开发（不经 Docker）

```bash
# 需要 Node.js ≥ 22
npm ci
npm --prefix amazon-oauth-service ci
npm --prefix amazon-sp-api-mcp ci
npm test
npm run typecheck:mcp
npm run build:mcp
```

分别用环境变量启动 OAuth / MCP（变量名见部署文档 §3.6），或继续用 Compose。

门禁脚本：

```bash
npm run ci-gate
```

---

## 常用运维

```bash
docker compose ps
docker compose logs -f --tail=200 amazon-sp-api
docker compose restart amazon-sp-api
docker compose down    # 不删除 config.yaml 与 data/
```

| 端点 | 含义 |
|---|---|
| `/healthz` | 进程存活 |
| `/readyz`（仅 MCP，本机） | 依赖就绪；失败 503 |

---

## 安全要点

- `config.yaml` **0600**，不进 Git / 镜像层  
- 应用只听 **127.0.0.1**，公网只走 HTTPS 反代  
- Refresh Token 仅密文存储  
- 生产关闭 legacy 共享 Token（`allowLegacyAuth: false`）  
- ConnectedAccount 未解锁前不要 `connected-account.enabled=true` 对外放量  

---

## 文档

| 文档 | 说明 |
|---|---|
| [docs/operations/DEPLOYMENT.md](docs/operations/DEPLOYMENT.md) | **完整部署指南** |
| [docs/operations/Amazon-SP-API管理.md](docs/operations/Amazon-SP-API管理.md) | Portal、角色、上线清单 |
| [docs/connected-account/](docs/connected-account/) | ConnectedAccount 设计与验收 |
| [docs/acceptance/](docs/acceptance/) | 版本化验收证据 |
| [docs/README.md](docs/README.md) | 文档总目录 |
