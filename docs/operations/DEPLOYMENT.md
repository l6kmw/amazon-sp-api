# 部署手册

单用户本地部署：一个进程、一个本地数据目录，不需要 PostgreSQL、Redis 或任何外部身份系统。
MCP 不做认证，因此服务只应监听回环地址。

## 1. 运行模型

入口为 `dist/server.js`，内部端口固定 `8789`（不接受 YAML 覆盖）。

```text
浏览器 / MCP 客户端
        │ HTTP（仅回环）
        ▼
  127.0.0.1:8789  amazon-sp-api
        └── /var/lib/amazon-sp-api（tokens/states/intents）
```

若要公网访问，必须在前置 Nginx 上完成认证，并且只把回环上游暴露给它。

## 2. 上线前准备

- Node.js `>=22.13.0` 与 Bun（源码运行），或 Docker/Compose。
- Amazon LWA Client ID 与 Client Secret。
- Amazon Portal 中登记的 Redirect URI 与 `amazon.publicOrigin + /oauth/amazon/callback` 完全一致。
- 一个可写的绝对路径作为 `storage.dataDirectory`。

先备份现有部署：

```bash
cp -p config.yaml config.yaml.bak
tar -C /var/lib/amazon-sp-api -czf amazon-sp-api-data-$(date +%F).tgz .
```

## 3. 生成配置

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
openssl rand -base64 32   # 填入 amazon.credentialKeys.keys[].secret
```

`config.yaml` 顶层只有三块：`server`、`amazon`、`storage`（以及可选的 `operator`，用于
`/company` 与 `/privacy` 法务页面）。加载器严格拒绝未知字段、重复键、弱密钥和不安全 URL。

## 4. 本地验收

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
git diff --check
```

完整的发布门禁（含只读验收脚本测试与差异检查）：

```bash
bun run ci-gate
```

## 5. Docker 部署

```bash
install -d -m 0700 data
sudo chown 10001:10001 config.yaml data
sudo chmod 0600 config.yaml
export AMAZON_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
docker compose build
docker compose up -d
docker compose ps
```

镜像固定以 UID/GID `10001:10001` 运行，`config.yaml`（0600）与 `data/`（0700）必须归该用户所有，
否则容器无法读取配置或写入数据。Compose 只绑定 `127.0.0.1:${AMAZON_PORT:-8789}`。

推送镜像仓库时应使用不可变提交标签，不要用 `latest`。

验证：

```bash
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/healthz | jq .
curl --fail http://127.0.0.1:${AMAZON_PORT:-8789}/readyz | jq .
```

`/healthz` 返回 `status/version/tools/lwaConfigured`；`/readyz` 检查 `lwa`、`tokenStore` 与
`encryptionKey` 三项，任一异常返回 503。

## 6. systemd 部署

构建产物放 `/opt/amazon-sp-api`，配置放 `/etc/amazon-sp-api/config.yaml`，数据放
`/var/lib/amazon-sp-api`：

```bash
sudo install -m 0644 deploy/amazon-sp-api.service /etc/systemd/system/amazon-sp-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now amazon-sp-api.service
sudo systemctl status amazon-sp-api.service
```

unit 只传入 `NODE_ENV=production` 与 `AMAZON_CONFIG_FILE`，并限制可写路径为数据目录。

## 7. Nginx 反向代理

参考 `deploy/api.example.com.nginx`。要点：

- 上游指向 `127.0.0.1:8789`。
- 公网暴露 `/mcp`、`/oauth/amazon/*`、`/api/v1/accounts*`。
- 若对公网开放，必须在 Nginx 层加认证：MCP 与账号接口本身不做认证。
- 不要暴露 `/readyz` 的详细 `checks`，或将其限制到内网。

## 8. 数据与密钥

- `tokens.json`、`states.json`、`intents.json` 位于 `storage.dataDirectory`。
- Refresh Token 同时支持 legacy 未版本化 envelope 与 v2 envelope，AAD、keyring、revision 语义不变。
- 加密密钥轮换：在 `amazon.credentialKeys.keys` 下新增一个 `keyId`，把 `currentKeyId` 指向它并重启。
  旧 key 必须保留，否则既有 Token 无法解密。两个 key 并存期间新旧数据都能读取。
- 升级前先停止旧进程，禁止新旧进程同时写同一数据目录。

## 9. 停止与回滚

应用收到 SIGTERM/SIGINT 后停止接收请求并关闭文件资源，Compose 宽限期 15 秒。

回滚：

1. 停止当前进程，避免新旧版本同时写数据目录。
2. 恢复上一版本代码与 `config.yaml`。
3. 数据目录结构未变，无需转换；若确认异常写入，从第 2 节备份恢复。
4. 恢复反向代理上游，验证 `/healthz`、管理员登录与一次只读 MCP 调用。

## 10. 故障定位

- `/healthz` 200 但 `/readyz` 503：读取 `checks`，分别检查 `lwa`、`tokenStore`、`encryptionKey`。
- OAuth 回调失败：核对 Portal 登记值与 `amazon.publicOrigin` 推导出的 `/oauth/amazon/callback`，
  包括协议、域名、路径与大小写。
- Host 被拒绝：把实际主机名加入 `server.allowedHosts`，不要带协议或路径。
- 文件权限失败：`chmod 600 config.yaml`、`chmod 700 data`，并确认 Secret File 为绝对路径且
  不允许组/其他用户读取。
- 端口占用：内部端口固定 8789，用 `AMAZON_PORT` 改宿主机映射，不要改 YAML。
