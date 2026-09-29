# Amazon SP-API 管理手册

当前部署是 `amazon-sp-api-service` 单包、单 Node 进程、单端口 `8789`。完整安装与回滚步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)，本页只保留日常管理命令。

## 服务状态

```bash
sudo systemctl status amazon-sp-api.service
sudo journalctl -u amazon-sp-api.service -n 200 --no-pager
curl --fail http://127.0.0.1:8789/healthz | jq .
curl --fail http://127.0.0.1:8789/readyz | jq .
```

`/healthz` 是进程 liveness；`/readyz` 才反映 LWA、Token Store、加密密钥和可选 PostgreSQL/Redis 依赖。服务不再访问外部 identity 端点。

## 配置位置

| 项目 | 默认位置 |
| --- | --- |
| 应用 | `/opt/amazon-sp-api` |
| systemd 单元 | `/etc/systemd/system/amazon-sp-api.service` |
| YAML 配置 | `/etc/amazon-sp-api/config.yaml`（`0600`） |
| 数据目录 | `/var/lib/amazon-sp-api`（`0700`） |
| Nginx 参考 | `deploy/api.example.com.nginx` |

运行时仅使用 `AMAZON_CONFIG_FILE` 和 `NODE_ENV`。OAuth、MCP 或存储参数都必须写入同一 `config.yaml`。

## 安全变更

- 修改 LWA、JWT、数据库或 Redis 凭证后：校验 YAML、重启服务、检查 `/readyz`。
- Refresh Token 密钥轮换：先保留新旧 key，执行 dry-run，再 `--apply`，观察后才移除旧 key。
- 不得恢复 `8788`、`oauth.internalSecret`、`AMAZON_INTERNAL_SECRET`、`AMAZON_OAUTH_INTERNAL_URL` 或 `/internal/amazon/*`。
- 不得恢复 `mcp` YAML 分区、全局共享 Bearer Token 或对 `host.docker.internal:8080` 的身份校验请求；`oat_*` 只能是数据库 Hash 校验、独立 Agent 归属、可轮换/吊销的一次性返回 Token。
- `connectedAccount.enabled=false` 只关闭 Employee JWT；若 PostgreSQL + 私密 Session Secret 已启用控制面，active Test Agent 仍可按 Scope 调用 `/mcp`。两类凭据均不可 fallback 为另一类。
- `admin.oa` 启用后，本地密码登录关闭；只有精确配置的 OIDC `issuer + sub` 可映射为固定管理员。OA 回调固定为 `amazon.publicOrigin + /api/v1/admin/oa/callback`，OA Client Secret 只能放在 `0600` Secret File。
- `config.yaml`、Secret File、备份文件不得允许 group/other 读取。

## 日常发布

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
sudo systemctl restart amazon-sp-api.service
curl --fail http://127.0.0.1:8789/readyz
```

文件模式发布前必须停止旧进程，禁止两个版本同时写数据目录。PostgreSQL/Redis 模式也应确保只有计划内实例处理回调。

## Nginx

管理 SPA/API、Amazon 集成 API、OAuth 和 MCP 均代理到 `127.0.0.1:8789`。必须使用仓库的 `deploy/api.example.com.nginx` 完整 allowlist；它包含 `/`、`/admin-config.js`、`/assets/*`、`/api/v1/admin/*`、`/amazon/api/*`、`/oauth/amazon/*`、`/mcp/amazon` 和 ConnectedAccount 路径。不要手抄一个遗漏管理控制面的精简片段。

集成方通过 `/amazon/api/status` 只读取 `ready` / `not_ready` 总体状态。不得公网代理 `/readyz`；它包含逐项依赖信息，只能从 `127.0.0.1:8789` 检查。

修改后执行 `sudo nginx -t && sudo systemctl reload nginx`。

## 备份与恢复

备份 `config.yaml`、整个数据目录、PostgreSQL 和当前密钥环；恢复时先停服务。应用回滚保留 expand/backfill Schema，不执行向下 DDL；数据恢复必须先在隔离库用相同 keyring 验证 Refresh Token 可解密，具体步骤见部署手册。
