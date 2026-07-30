# Amazon SP-API 单服务部署手册

本文描述当前单包、单进程、单端口版本。历史双服务验收记录保留在 `docs/acceptance/`，不代表当前部署方式。

## 1. 运行模型

唯一入口为 `dist/server.js`，唯一容器端口为 `8789`。OAuth、MCP、ConnectedAccount、健康检查使用同一个 Express 应用；一个 PostgreSQL Pool 和一个 Redis Client 被注入所有消费者。

```text
Amazon / 用户 / Agent
        │ HTTPS
        ▼
      Nginx
        │ 127.0.0.1:8789
        ▼
 amazon-sp-api（一个 Node 进程）
        ├── PostgreSQL（可选；ConnectedAccount 必需）
        ├── Redis（可选；ConnectedAccount 必需）
        └── /data（文件兼容模式）
```

不再部署 OAuth `8788`、第二个 systemd 单元、容器 entrypoint 进程管理器或内部 OAuth HTTP API。

## 2. 上线前准备

要求：

- Node.js `>=22.13.0`，Bun `1.3.6`；或 Docker/Compose。
- 公网 HTTPS 域名和反向代理。
- Amazon Portal 中的 Redirect URI 与 `amazon.publicOrigin + /oauth/amazon/callback` 完全一致。
- `config.yaml` 权限 `0600`，数据目录权限 `0700`。
- 文件模式升级时可安排短暂停机；PostgreSQL/Redis 模式可先使用临时宿主端口验证。

先备份：

```bash
cp -p config.yaml config.yaml.before-single-service
tar -C data -czf amazon-sp-api-data-before-single-service.tgz .
pg_dump --format=custom --file=amazon-sp-api-before-single-service.dump "$DATABASE_URL"
```

另行保留旧镜像和旧双服务配置。不要把备份或真实密钥提交到仓库。

## 3. 生成单服务配置

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
openssl rand -base64 32
```

从旧配置迁移时：

1. 将 `server.oauth`、`server.mcp` 合并为 `server.host`、`server.allowedHosts`，并删除 `server.port`；内部端口固定为 `8789`。
2. 删除整个 `oauth` 分区，把 `oauth.dataDirectory` 原值移动到 `storage.dataDirectory`。
3. 删除 `amazon.oauthRedirectUri`；确认 Amazon Portal 登记值等于 `amazon.publicOrigin + /oauth/amazon/callback`。
4. 将 `amazon.tokenEncryptionKey: <原值>` 改为 `amazon.credentialKeys.currentKeyId: k0`，并把原值放入 `keys` 的 `keyId: k0` 条目；无需重加密现有 Token。
5. 删除整个 `mcp` 分区，包括 `identityValidationUrl`、`identityHealthUrl`、`enableListingsTools`、`limits`、`cache` 和所有 Legacy Auth 字段。MCP 接受 `connected-account.jwtKeys` 本地验签的 Employee JWT；仅在 PostgreSQL 与私密 `admin.sessionSecretFile` 均配置时，额外接受数据库中 active Test Agent 的独立 `oat_*` Token。
6. 删除 `storage.postgres.schema`；数据库 Schema 固定为 `amazon_sp_api`。

加载器严格拒绝旧布局、未知字段、重复键、弱密钥、过宽权限和不安全 URL，不会静默猜测。

## 4. 本地构建验收

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
bun run test:docker-config
git diff --check
```

如需完整镜像门禁：

```bash
CI_GATE_DOCKER_IMAGE=true bun run ci-gate
```

镜像验证会确认 `/app/dist/server.js` 可导入，运行时没有 Bun，也没有旧 `amazon-oauth-service`、`amazon-sp-api-mcp` 子包。

## 5. Compose 部署

```bash
install -d -m 0700 data
sudo chown 10001:10001 config.yaml data
sudo chmod 0600 config.yaml
export AMAZON_IMAGE_REVISION="$(git rev-parse HEAD)"
export AMAZON_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
export AMAZON_PLATFORM=linux/amd64
docker compose build
docker compose up -d
docker compose ps
```

镜像固定以 UID/GID `10001:10001` 运行。`config.yaml` 使用 `0600`、`data/` 使用 `0700` 时，
两者必须归该 UID/GID 所有，否则容器无法读取配置或写入数据。部署阿里云镜像仓库版本时，
将 `AMAZON_IMAGE_REPOSITORY` 设为完整仓库路径并使用同一个不可变提交标签；不要使用 `latest`。

Compose 只绑定：

```text
127.0.0.1:${AMAZON_PORT:-8789} -> 容器 8789
```

不要配置 `AMAZON_OAUTH_PORT` 或暴露 `8788`。

验证：

```bash
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/healthz | jq .
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/readyz | jq .
docker compose exec amazon-sp-api sh -c 'test "$(ls /proc/1/task | wc -l)" -ge 1'
```

`/healthz` 应返回 HTTP 200 和 `status/version/tools/lwaConfigured`；`/readyz` 仅在 `lwa`、`tokenStore`、`encryptionKey` 及已配置的 PostgreSQL/Redis 全部正常时返回 200。它不检查外部 identity 端点。

Employee JWT 未启用时，`/mcp` 对 Employee JWT 返回 401；若 PostgreSQL 与私密 `admin.sessionSecretFile` 已配置，数据库中 active Test Agent 的独立 `oat_*` 仍可按 Scope 访问同一 `/mcp`。Employee JWT 启用后必须配置 PostgreSQL、Redis、`connected-account.audience`、HTTPS `allowedOrigins` 和 `jwtKeys`。

## 6. Nginx 切换

参考 `deploy/api.example.com.nginx`。关键映射：

| 公网路径 | 单一上游 |
| --- | --- |
| `/`、`/admin-config.js`、`/assets/*` | 管理 SPA 与 no-store runtime config |
| `/api/v1/admin/*` | 管理 Session/CSRF 控制面 |
| `/amazon/api/*` | `127.0.0.1:8789` |
| `/oauth/amazon/*` | `127.0.0.1:8789` |
| `/mcp/amazon`、`/mcp/amazon/healthz` | `127.0.0.1:8789/mcp`、`/mcp/healthz` |
| `/.well-known/connected-account` | `127.0.0.1:8789` |
| `/connected-account/v1/*` | `127.0.0.1:8789` |

切换前执行 `nginx -t`，切换后执行：

```bash
curl --fail https://api.example.com/healthz | jq .
curl --fail https://api.example.com/amazon/api/status | jq .
curl --fail https://api.example.com/ | grep -F '/admin-config.js'
test "$(curl -sSI https://api.example.com/admin-config.js | awk 'BEGIN{IGNORECASE=1}/^cache-control:/{print $2}' | tr -d '\r')" = no-store
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api.example.com/api/v1/admin/session)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api.example.com/readyz)" = 404
curl -i https://api.example.com/internal/amazon/connections
```

集成状态接口只返回脱敏的 `ready` / `not_ready`；公网 `/readyz` 和旧内部路径必须为 404。详细 readiness 只在回环地址检查。随后完成一次真实 Amazon 授权和一次只读 MCP 调用。

## 7. systemd 部署

将构建产物放在 `/opt/amazon-sp-api`，配置放在 `/etc/amazon-sp-api/config.yaml`，数据放在 `/var/lib/amazon-sp-api`。安装 `deploy/amazon-sp-api.service`：

```bash
sudo install -m 0644 deploy/amazon-sp-api.service /etc/systemd/system/amazon-sp-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now amazon-sp-api.service
sudo systemctl status amazon-sp-api.service
```

systemd 只传入 `NODE_ENV=production` 和 `AMAZON_CONFIG_FILE`；敏感配置不再拆到多个 EnvironmentFile。

## 8. 文件与 PostgreSQL 兼容

- `tokens.json`、`states.json`、`intents.json` 的路径和 JSON 结构保持兼容。
- Refresh Token 同时支持 legacy 未版本化 envelope 和 v2 envelope，AAD、keyring、revision 语义不变。
- PostgreSQL Schema 通过版本表按 `expand → backfill → switch → contract` 演进；禁止手工 DDL 或跳过版本。
- 文件模式升级时必须先停止旧版本，禁止新旧进程同时写同一目录。

上线前在与应用相同的配置和镜像中显式执行：

```bash
AMAZON_CONFIG_FILE=/etc/amazon-sp-api/config.yaml bun run postgres:migrate
AMAZON_CONFIG_FILE=/etc/amazon-sp-api/config.yaml bun run postgres:backfill
```

确认输出 Schema version `3`，并核对 backfill 的 Account、Credential、active Binding 计数后才切流。应用启动仍会幂等检查 migration，不能替代上述部署步骤。

文件导入 PostgreSQL：

```bash
AMAZON_CONFIG_FILE=/etc/amazon-sp-api/config.yaml bun run storage:migrate
```

密钥轮换：

```bash
AMAZON_CONFIG_FILE=/etc/amazon-sp-api/config.yaml bun run storage:rotate-key
AMAZON_CONFIG_FILE=/etc/amazon-sp-api/config.yaml bun run storage:rotate-key -- --apply
```

## 9. 停止与回滚

应用收到 SIGTERM/SIGINT 后先停止接收请求，再关闭 SQLite、Redis 和 PostgreSQL 资源。Compose 的宽限期为 15 秒。

回滚步骤：

1. 停止新单服务，避免新旧版本同时写 PostgreSQL、Redis 或文件目录。
2. 若仅应用回滚，恢复上一镜像和与其匹配的配置；expand/backfill Schema 保留，不执行向下 DDL。
3. 若确认新版本产生异常数据写入，恢复切流前 `pg_dump --format=custom` 备份到隔离库，先用相同 keyring 验证 Refresh Token 可解密，再经变更审批替换业务库。
4. 恢复反向代理上游，启动上一版本，验证健康、管理员 Session、真实授权和只读 MCP 调用。

禁止直接删除 migration v2/v3 表或恢复旧排他约束；这会破坏多 Owner Credential 和 active Binding。仓库的 `npm run test:real-staging` 已覆盖显式 v3 migration、`pg_dump → restore` 以及相同 keyring 的 Repository Refresh Token 解密。

## 10. 故障定位

- `/healthz` 200、`/readyz` 503：读取 `checks`，分别检查 LWA、Token Store、密钥、PostgreSQL 和 Redis；当前 readiness 不含 identity。
- 旧 YAML 启动失败：按字段级错误提示迁移到 v2，不要重新加入兼容字段。
- OAuth 回调失败：核对 Portal 登记值与 `amazon.publicOrigin` 推导出的 `/oauth/amazon/callback`，包括协议、域名、路径和大小写。
- Host 被拒绝：把实际公网主机名加入 `server.allowedHosts`，不要加入协议或路径。
- 文件权限失败：`chmod 600 config.yaml`、`chmod 700 data`，并检查 Secret File 为绝对路径且不允许组/其他用户读取。
