# Amazon SP-API MCP（单用户版）

这是一个单用户本地 Amazon SP-API MCP 服务：单进程、单端口，所有状态存于一个本地目录。
不需要 PostgreSQL、Redis 或任何外部身份系统，MCP 不做认证（服务只应监听回环地址）。

管理控制台的“Amazon 连接”页面统一展示 SP-API 与独立 `amazon-ads-mcp` Provider。Ads 数据由 SP 后端在管理员 Session、CSRF 和审计之后，通过固定回环地址代理；浏览器不会读取 Ads Store、Refresh Token 或 OAuth state。两类 Provider 的 OAuth、Credential、Grant/Binding、JWT audience 和 MCP 进程保持独立。

管理入口支持统一 OA 的标准 OIDC Authorization Code + PKCE 登录。`admin.oa` 启用后，本地管理员密码入口关闭；只有配置中精确匹配的 OA `issuer + sub` 会映射为固定 `tenant-1` 管理员。OIDC state、nonce 和 code verifier 仅存在于 10 分钟有效的加密 HttpOnly 流程 Cookie，成功回调后继续使用原有 HttpOnly/Strict 管理 Session、CSRF 与审计。未配置 `admin.oa` 时保留原密码登录，作为显式配置级兼容和回滚模式。

## 架构

```text
浏览器 / MCP
          │ HTTPS
        Nginx
          │ 127.0.0.1:8789
          ▼
  dist/server.js（单一 Node 进程）
    ├─ /oauth/amazon/*
    ├─ /api/v1/admin/oa/*
    ├─ /mcp
    ├─ /.well-known/connected-account
    ├─ /api/v1/accounts/*
    ├─ /healthz、/readyz
    └─ /internal/metrics
          │
          ├─ 文件模式：tokens.json / states.json / intents.json / connected-account.sqlite
```

旧 `8788` 监听、`/internal/amazon/*`、`AMAZON_OAUTH_INTERNAL_URL`、`AMAZON_INTERNAL_SECRET` 和双服务配置均已删除。旧内部路径始终返回 404；Amazon Portal 的公网回调仍是 `/oauth/amazon/callback`。

## 环境要求

- Node.js `>=22.13.0`（该版本起 [`node:sqlite`](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html) 不再需要启动标志）
- Bun `1.3.6`
- 可选：Docker/Compose

应用最终运行在 Node.js 上；Bun 只负责依赖安装和脚本执行。生产镜像不包含 Bun。

## 本地开发

```bash
bun install --frozen-lockfile
cp config.example.yaml config.yaml
chmod 600 config.yaml
```

编辑 `config.yaml`，至少替换 LWA、Application ID、加密密钥和 Selling Partner ID 占位值。配置文件是唯一运行时配置源；环境变量只识别：

- `AMAZON_CONFIG_FILE`：配置文件路径，默认当前目录的 `config.yaml`
- `NODE_ENV`：运行环境标识

启动热重载：

```bash
bun run dev
```

调试时可在编辑器中运行 `tsx src/server.ts`，或给 `bun run dev` 附加 Node Inspector。单进程架构下，OAuth 回调和 MCP 工具共享断点、连接存储和日志上下文，不再需要同时调试两个进程。

常用检查：

```bash
bun run test:docker-config
bun run test
bun run typecheck
bun run build
node dist/server.js
```

本机 Node 低于 22.13 时，`node:sqlite` 仍可能需要实验标志；正式开发和部署应直接升级，不要把该标志写入生产服务。

## 配置与存储

完整中文字段说明见 [`config.example.yaml`](./config.example.yaml)。核心结构为：

```yaml
server:
  host: "0.0.0.0"
  allowedHosts: ["api.example.com", "127.0.0.1", "localhost"]
storage:
  dataDirectory: "/data"
```

- 服务内部端口固定为 `8789`，不接受 YAML 配置；宿主端口使用 Compose 的 `AMAZON_PORT` 映射。
- OAuth 回调由 `amazon.publicOrigin` 固定推导为 `/oauth/amazon/callback`，推导结果必须与 Amazon Portal 完全一致。
- `amazon.credentialKeys` 是唯一加密密钥配置；旧密钥可按原值迁移为 `keyId: k0`，无需重加密 Token。
- MCP 不做认证：服务只应监听回环地址，所有调用都归属固定的本地 owner。
- Listings 和其他 Seller 非受限只读工具固定注册；Provider 不对 MCP 入口实施请求/并发限流，也不根据 Amazon usage-plan Header 本地排队。连接/区域缓存固定为 30 秒/24 小时，不接受 YAML 覆盖；Amazon 返回 429 时仍映射为 `rate_limited` 并按幂等边界执行有界退避重试。
- 文件存储保持旧 `tokens.json`、`states.json`、`intents.json` 及加密 envelope 格式。

## 本地部署

### 1. 取得 Amazon LWA 凭证

在 [Seller Central](https://sellercentral.amazon.com/) 注册 SP-API 应用，拿到 LWA Client ID 与
Client Secret，并登记回调地址为 `<amazon.publicOrigin>/oauth/amazon/callback`。

### 2. 生成加密密钥

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
openssl rand -base64 32   # 填入 amazon.credentialKeys.keys[0].secret
```

### 3. 启动

```bash
npm ci
npm run build
AMAZON_CONFIG_FILE=$PWD/config.yaml npm start
```

服务监听 `server.host:server.port`（默认 `127.0.0.1:8789`），数据写入 `storage.dataDirectory`。

### 4. 连接 Amazon 账号

```bash
# 发起授权，返回 authorizationUrl，在浏览器打开
curl -s -X POST http://127.0.0.1:8789/api/v1/accounts/authorization-attempts | jq .

# 查询进度
curl -s http://127.0.0.1:8789/api/v1/accounts/authorization-attempts/<attemptId> | jq .

# 已连接账号
curl -s http://127.0.0.1:8789/api/v1/accounts | jq .
```

MCP 端点：`POST http://127.0.0.1:8789/mcp`，**无需 Authorization 头**。

### 安全边界

MCP 与账号管理接口都不做认证，因此服务只应绑定回环地址。若必须对外暴露，
请在前面放一层带认证的反向代理。

## HTTP 契约

| 路径 | 用途 |
| --- | --- |
| `/oauth/amazon/login` | Amazon 登录桥 |
| `/oauth/amazon/start` | 打开授权同意页 |
| `/oauth/amazon/renew` | 打开 Manage Your Apps 续期入口 |
| `/oauth/amazon/callback` | Amazon Portal 固定回调 |
| `/api/v1/admin/oa/login` | 创建 OA OIDC PKCE 登录并跳转到 OA |
| `/api/v1/admin/oa/callback` | 校验 OA 回调并签发本地管理 Session |
| `/amazon/api/config` | 对接方使用的脱敏 MCP 与 Provider 元数据 |
| `/amazon/api/status` | 对接方使用的脱敏总体 readiness |
| `/mcp` | Streamable HTTP MCP |
| `/api/v1/accounts/*` | 账号列表、授权尝试与断开（无需认证） |
| `/healthz` | 进程 liveness，始终反映进程是否可服务 HTTP |
| `/readyz` | LWA、Token Store 与加密密钥 readiness |
| `/internal/metrics` | 回环 Prometheus 指标 |

`/healthz` 返回 `status`、`version`、`tools`、`lwaConfigured`。依赖异常不改变 liveness；回环 `/readyz` 在任一必需依赖失败时返回 503 并包含逐项检查。公网只暴露 `/amazon/api/config` 和 `/amazon/api/status`，`/amazon/` 不提供前端页面，`/readyz` 继续返回 404。

## Seller 全量只读 MCP

以 Amazon 官方模型提交 `6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad` 为冻结基线，353 个 operation 必须逐一分类；当前纳入 93 个 Seller 非受限、未弃用且不改变业务状态的操作。`amazon_get_read_capabilities` 返回 action、所需角色、区域和当前权限状态，17 个 `amazon_<domain>_read` 工具只接受注册表中的 action，不接受任意 URL、path 或 method。

详细的领域、角色、操作清单、排除理由和模型同步流程见 [`docs/SP-API-READ-CAPABILITIES.md`](./docs/SP-API-READ-CAPABILITIES.md)；机器可读的 353 项覆盖矩阵位于 [`vendor/amazon-sp-api-models/operations.json`](./vendor/amazon-sp-api-models/operations.json)。

## Docker 部署

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
mkdir -p data
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/healthz
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/readyz
```

Compose 只映射 `127.0.0.1:${AMAZON_PORT:-8789}:8789`。公网必须经过 HTTPS 反向代理，参考 [`deploy/api.example.com.nginx`](./deploy/api.example.com.nginx)。systemd 参考 [`deploy/amazon-sp-api.service`](./deploy/amazon-sp-api.service)。

详细上线、备份、验证和回滚流程见 [`docs/operations/DEPLOYMENT.md`](./docs/operations/DEPLOYMENT.md)。

### 运营主体信息（自部署必读）

`/company` 与 `/privacy` 是面向 Amazon 卖家应用审核的公开法务页面，内容由 `operator` 配置段渲染：

```yaml
operator:
  name: "Example Operator"
  legalName: "示例运营主体有限公司"
  legalNameEn: "Example Operator Ltd."
  url: "https://operator.example.com"
  email: "privacy@operator.example.com"
  siteUrl: "https://api.operator.example.com"
  registrationId: "91310000MA1FL0000X"
```

未配置 `operator` 时，页面按模板原样输出 `{{OPERATOR_*}}` 占位符——这是刻意行为：不填写就不会冒用其他公司的法定名称、联系邮箱或注册号，该状态**不可用于提交 Amazon 审核**。

## 发布门禁

```bash
bun run ci-gate
CI_GATE_DOCKER_IMAGE=true bun run ci-gate
```

门禁执行冻结依赖安装、测试、类型检查、构建、敏感信息扫描、配置测试，并可选构建镜像和验证运行时中没有 Bun、旧子包或第二个入口。
