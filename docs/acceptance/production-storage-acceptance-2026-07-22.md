# Amazon SP-API 生产存储与多实例技术验收

> 日期：2026-07-22
> 服务器：example
> 部署提交：`8947ff0`
> 结论：PostgreSQL、Redis、多实例协调和现有旧实现生产路径通过技术验收。

## 验收范围

- OAuth connection、ConnectedAccount Attempt/Grant/Binding/Account 使用 PostgreSQL 持久化。
- OAuth state/intent 和 LWA Access Token 使用 Redis TTL 存储。
- LWA 刷新使用 Redis 分布式锁；schema 初始化、Attempt 完成和绑定使用数据库事务与唯一约束。
- 两个 OAuth 与两个 MCP 实例共享同一 PostgreSQL schema 和 Redis namespace。
- 现有加密 JSON 连接迁移、生产切换、健康检查和回滚能力。

不包含 Amazon Portal 审核、政策 URL、审核录屏、真实 ConnectedAccount issuer/key/origin 和 M4 对外开放事项。

## 存储迁移

- 复用 example 本机 PostgreSQL 17 和 Redis 8，仅监听 `127.0.0.1`。
- 新建独立数据库与 role `amazon_sp_api`，表位于 `amazon_sp_api` schema。
- Redis 使用 `amazon-sp-api:` namespace，tenant、seller、state 和锁输入经 SHA-256 后进入 key。
- 迁移 1 条 AES-GCM 加密连接：源记录数与数据库记录数一致；缺失 tenant 0，缺失密文 0。
- 原 `tokens.json` 保持不变，作为回滚兼容副本，不再作为新版本生产真相源。

## 自动化与并发

- MCP：88/88 tests、typecheck、build 通过。
- OAuth：13/13 tests 通过。
- 两个独立连接池在空 schema 上并发初始化通过；DDL 由同一事务级 advisory lock 串行化。
- 两个 OAuth 实例竞争同一 intent：一次成功、一次拒绝；合成 state 已精确清理。
- Attempt 在 MCP A 创建、MCP B 查询成功；合成数据库记录和 Redis intent 已精确清理。
- 两个真实 LWA provider 并发读取 PostgreSQL 密文并共享 Redis lock，仅发生一次 LWA exchange；验收缓存已清理。

## Canary 与生产

- OAuth A/B health：database、redis、LWA 配置均为健康。
- MCP A/B readiness：Token Store、OAuth、加密密钥、PostgreSQL、Redis、身份服务 6/6 通过。
- ConnectedAccount 只读脚本在两个 canary 实例均通过 discovery、MCP health、临时 Employee JWT 和空账号列表检查。
- 生产 OAuth 与 MCP 均为 `active/running`，release marker 为 `8947ff0`。
- 生产 `/readyz`、OAuth `/healthz` 和公网 Amazon MCP health 均返回 200。
- systemd unit verify、Nginx 配置检查通过；生产日志真实 Secret/Refresh Token 命中数为 0。

## 回滚

- 回滚包：`/var/backups/amazon-sp-api/20260722T005337Z/pre-8947ff0`
- 内容包括旧 `/opt`、systemd unit、受限 env、Nginx 配置、原加密 JSON 和 PostgreSQL custom-format dump。
- `SHA256SUMS` 已逐项校验通过。
- 旧服务目录保留为 `2219933` 快速回退版本；新 schema 对旧版本无破坏性修改。

## 未开放项

`CONNECTED_ACCOUNT_ENABLED` 继续保持 `false`。开启前仍需真实 ConnectedAccount issuer、JWT key/kid、精确 allowed origins，并完成凭据加密 key 版本化轮换和 M4 人工/合规验收。上述事项不影响当前旧实现生产路径使用 PostgreSQL、Redis 与多实例锁。
