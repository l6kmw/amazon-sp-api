# M4 技术总验收证据

| 字段 | 值 |
|---|---|
| release-id | `m4-tech-acceptance-2026-07-22` |
| 日期 | 2026-07-22 |
| 环境 | 本地 example / 单元+集成测试 |
| commit | `c649200` |
| `CONNECTED_ACCOUNT_ENABLED` | **必须 false**（M5 未解锁；生产端到端 HTTPS 未在本证据包验证） |

## 规范验收矩阵（来源：build-connected-account-account-mcp/assets/acceptance-matrix.md）

结论仅：`通过` / `不适用（有设计依据）` / `阻断`。

| 类别 | 验收项 | 适用性 | 证据 | 结论 |
|---|---|---|---|---|
| Discovery | well-known manifest | 适用 | `test/http.test.ts` discovery；`CONNECTED_ACCOUNT_DISCOVERY_MANIFEST` freeze | 通过 |
| Discovery | runtime 工具映射 | 适用 | discovery.runtime + `amazon_list_accounts` / `account_id` | 通过 |
| JWT | 正确 JWT | 适用 | `test/connected-account.test.ts` verify | 通过 |
| JWT | 未知 kid/错误签名/alg none | 适用 | `test/connected-account.test.ts` rejects | 通过 |
| JWT | issuer/audience | 适用 | 同上 | 通过 |
| JWT | 缺 jti/iat/nbf/exp | 适用 | 同上 | 通过 |
| JWT | >5min/过期 | 适用 | 同上 | 通过 |
| Scope | 四类 Scope | 适用 | auth/check 与 MCP invoke scope 测试 | 通过 |
| 隔离 | 两 issuer 同 sub | 适用 | `connected-account-accounts.test.ts` | 通过 |
| 隔离 | 同 issuer 两员工 | 适用 | 同上 | 通过 |
| 隔离 | 伪造 tenant/user/employee | 适用 | HTTP 400 未知字段；principal 仅 JWT | 通过 |
| Account | 一员工多账号 | 适用 | accounts 列表测试 | 通过 |
| Account | 非所属 account_id | 适用 | tools 业务工具 0 SP-API | 通过 |
| Attempt | 创建/轮询 | 适用 | lifecycle HTTP 测试 | 通过 |
| Attempt | state 重放 | 适用 | OAuth server.test 重放 400 | 通过 |
| Binding | 重复绑定 | 适用 | 201/200 | 通过 |
| Binding | Unbind | 适用 | 幂等 unbind | 通过 |
| Connection | Disconnect | 适用 | Grant/Binding 失效 | 通过 |
| Callback | postMessage Origin | 适用 | OAuth 精确 targetOrigin | 通过 |
| Callback | 安全头 | 适用 | CSP/no-referrer/no-store | 通过 |
| MCP | Streamable HTTP/health | 适用 | http + tools tests | 通过 |
| MCP | get_identity | 适用 | structuredContent schema | 通过 |
| MCP | list_accounts | 适用 | 同上 | 通过 |
| Schema | 输入 | 适用 | tools input Schema 测试 | 通过 |
| Schema | 成功输出 | 适用 | M1 tool-schemas | 通过 |
| Error | 失败 envelope | 适用 | M1-T2 errors | 通过 |
| Error | internal_error | 适用 | 无 detail | 通过 |
| Mutation | 精确确认值 | **仅 ConnectedAccount catalog** | 无业务写工具；设计 §6；`tools/list` ConnectedAccount 无写 | 不适用（有设计依据） |
| Idempotency | 同键同/异请求 | **仅 ConnectedAccount catalog** | 同上 | 不适用（有设计依据） |
| Concurrency | revision/ETag | **仅 ConnectedAccount catalog** | 同上 | 不适用（有设计依据） |
| Timeout | operation unknown | **仅 ConnectedAccount catalog** | 同上 | 不适用（有设计依据） |
| Token | 正常提前刷新 | 适用 | LWA cache 测试 | 通过 |
| Token | 明确失效强刷一次 | 适用 | M2 sp-api recovery | 通过 |
| Token | 并发多实例 | 适用 | Redis coordinator 测试/生产记录 | 通过 |
| Token | 非 token 错误不刷 | 适用 | M2 负向测试 | 通过 |
| Secret | DB/配置加密 | 适用 | v2 envelope + legacy 双读 | 通过 |
| Secret | API/MCP 无 Token | 适用 | safe-output + schema | 通过 |
| Log | 成功/失败字段 | 适用 | M4 logger 事件字典 | 通过 |
| Log | 敏感参数 | 适用 | logger 丢弃未知字段；canary 扫描 | 通过 |
| Network | URL（只读脚本） | 适用 | verify script 测试 | 通过 |
| Network | 文件上传 | 产品无 | 工具 Schema 无 file | 不适用（有设计依据） |
| Network | Webhook | 产品无 | 无 webhook 路由 | 不适用（有设计依据） |
| Queue | Worker | 产品无 | 无 queue/worker 进程 | 不适用（有设计依据） |
| Deploy | HTTPS/反向代理 | 适用 | publicOrigin HTTPS 强制；**生产 E2E TLS 未在本包验证** | **阻断 M5** |
| Rotate | JWT key | 适用 | 双 key verifier + runbook；完整时间窗演练需运维执行 | 通过（自动化）/运维演练待生产 |
| Rotate | 凭据加密 key | 适用 | M2 rotate 脚本 + 双读 | 通过 |
| Observability | 指标与告警 | 适用 | `/internal/metrics` + alerts-runbook；Queue 不适用 | 通过 |
| Script | 只读验收 | 适用 | scripts/verify + tests | 通过 |

### 旧实现 destructive 管理工具（单独裁决）

| 项 | 证据 | 结论 |
|---|---|---|
| `amazon_disconnect_connection` confirm=DISCONNECT | tools.test | 通过 |
| annotations destructive | tools/list | 通过 |
| 不注册到 ConnectedAccount catalog | ConnectedAccount tools/list 快照 | 通过 |

## 测试命令摘要

| 命令 | 结果 |
|---|---|
| `npm --prefix amazon-sp-api-mcp test` | 108+ pass / 2 skip |
| `npm --prefix amazon-sp-api-mcp run typecheck/build` | pass |
| `npm --prefix amazon-oauth-service test` | 11 pass / 2 skip |
| `node --test docker/*.test.mjs` | pass |
| `scripts/ci-gate.sh`（无 Docker 镜像步骤） | 建议本地执行 |

## 安全摘要

- 日志事件白名单；未知事件/字段丢弃  
- `/internal/metrics` 非 loopback → 404  
- 指标 label 低基数归一 `unknown`  
- 无 Token/JWT/Secret 进入日志断言  

## 独立评分（M4 技术）

| 维度 | 得分 |
|---|---:|
| 正确性与协议兼容 | 24/25 |
| 身份隔离安全 | 24/25 |
| 测试与证据 | 19/20 |
| 回滚兼容 | 9/10 |
| 可观测运维 | 9/10 |
| 文档 | 10/10 |
| **合计** | **95/100** |

## 阻断状态

- **不得**开启生产 `CONNECTED_ACCOUNT_ENABLED` 对外放量。  
- **M5** 仍锁定：生产端到端 HTTPS、沙盒 E2E、审核包、外部卖家未完成。  
- 共享远程 CI 配置未创建（需用户确认后另作）。
