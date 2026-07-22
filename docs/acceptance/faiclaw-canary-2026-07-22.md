# ConnectedAccount Canary 验收证据

| 字段 | 值 |
|---|---|
| release-id | `connected-account-canary-2026-07-22` |
| 日期 | 2026-07-22（Asia/Shanghai） |
| 环境 | example 独立回环 canary，验收后已清理 |
| canary commit | `51c584c` |
| 生产 commit | `8947ff0`，未切换 |
| canary 入口 | `127.0.0.1:8790`，未接入公网 Nginx |
| 生产 `CONNECTED_ACCOUNT_ENABLED` | 保持关闭 |

## 发布与隔离

- 发布包仅由 Git `HEAD` 导出，SHA-256 为
  `6129714500b3297070ff81b42e4e74052478200a148b6e08ca92787cdd8c9d15`。
- canary 使用独立 release 目录、临时 systemd unit、两个临时 issuer/key 和 4 分钟 Employee JWT。
- signing secret、JWT、DSN、内部账号和生产凭据均未写入仓库、验收输出或日志。
- canary 只监听 `127.0.0.1:8790`；生产 OAuth、MCP 和 Nginx 未重启。

## Release 验证

服务器 Node `24.16.0`、npm `11.13.0`：

| 检查 | 结果 |
|---|---|
| `npm ci` | 通过 |
| MCP tests | 108 pass / 2 conditional skip / 0 fail |
| TypeScript typecheck | 通过 |
| production build | 通过 |
| `dist/server.js` import | 通过 |

本机 Node `26.5.0` 运行 OAuth 测试时触发 Node native assertion；因此 release
裁决以服务器生产同主版本 Node 24 的结果为准，不把本机崩溃记为代码通过。

## 只读脚本

使用下载版 `build-connected-account-account-mcp/scripts/verify_connected-account_account_mcp.py`
通过 stdin 在 canary 执行，结果 4/4：

| 检查 | 结果 |
|---|---|
| discovery manifest | protocol 1.0 / `amazon-sp-api` |
| `/mcp/healthz` | HTTP 200 |
| `/connected-account/v1/auth/check` | 短期 JWT 通过 |
| `/connected-account/v1/accounts` | HTTP 200，隔离账号 0 条 |

## 运行时验收

| 类别 | 证据 | 结论 |
|---|---|---|
| Readiness | token store、OAuth、加密、PostgreSQL、Redis、identity 6/6 `ok` | 通过 |
| JWT 负向 | 无 Token、错误签名、未知 kid、错误 issuer/audience、过期、超过 5 分钟、缺 jti | 通过 |
| Scope | 非协议 Scope 在 auth/check 返回 403；无 `mcp:invoke` 的 MCP 请求返回 403 | 通过 |
| 身份隔离 | 同 issuer 两个 Employee、两个 issuer 相同 Employee 均只看到自己的空账号集合 | 通过 |
| owner 覆盖 | `accounts/lookup` 伪造 `tenant` 字段返回 400 | 通过 |
| Attempt 归属 | 格式合法但不存在的 Attempt 对两个 Employee 均返回 404 | 通过 |
| MCP transport | initialize、tools/list、tools/call 完成 | 通过 |
| ConnectedAccount catalog | 12 个工具；4 个旧实现连接管理工具不可见 | 通过 |
| 账号参数 | 10 个业务工具均要求 `account_id`，且不暴露 `sellingPartnerId` | 通过 |
| 身份工具 | `amazon_get_identity` 只返回安全 Employee 摘要 | 通过 |
| 账号工具 | `amazon_list_accounts` 返回空集合和正确成功 Schema | 通过 |
| 非所属账号 | 格式合法的未知 `account_id` 返回 `resource_not_found`、`isError=true`，无 `structuredContent` | 通过 |
| 日志脱敏 | JWT、两把临时 signing secret 和高风险 Token 模式命中 0 | 通过 |

## 生产与清理

- 生产 OAuth PID、MCP PID、启动时间、`NRestarts=0` 和 `8947ff0` 标记均未变化。
- 公网 Amazon MCP health 保持 200；ConnectedAccount discovery 保持 404；未认证 MCP 保持 401。
- 验收产生 3 条合成 Employee；Attempt、Grant、Binding、Credential 均为 0。
- canary 停止后事务删除 3 条 Employee，五类合成数据计数全部归零。
- 临时 unit、环境文件、JWT key、release 目录、上传包和 8790 监听均已删除。

## 已知限制

- 本次验证的是空账号只读契约，没有创建真实 Amazon 授权、Binding 或调用真实账号业务数据。
- `npm prune --omit=dev` 摘要报告 2 个 moderate、1 个 high；在线 `npm audit`
  因 registry 错误未返回可裁决报告。生产提升前必须重新获取审计详情并完成影响判断。
- 真实 ConnectedAccount issuer、生产 key/kid、allowed origins 和 M5 人工/外部验收仍未提供。

## 独立评分

| 维度 | 得分 |
|---|---:|
| 正确性与协议兼容 | 24/25 |
| 身份、隔离与安全 | 23/25 |
| 测试与真实证据 | 18/20 |
| 回滚与数据兼容 | 10/10 |
| 可观测与运维 | 8/10 |
| 文档与可维护性 | 10/10 |
| **合计** | **93/100** |

## 结论

独立 canary 的短期 JWT、只读协议和 MCP 账号隔离验收通过。该结果不等于生产
ConnectedAccount 已可正式启用；生产依赖审计、真实身份配置、真实账号沙盒链路和 M5 人工验收仍阻断开放。
