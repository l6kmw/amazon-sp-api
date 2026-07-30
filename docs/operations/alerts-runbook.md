# Amazon ConnectedAccount 指标与告警 Runbook

指标前缀：`amazon_connected-account_`。抓取端点：各进程 `GET /internal/metrics`（**仅 loopback**；公网 404）。

## 指标清单（冻结）

| 指标 | type | labels | owner |
|---|---|---|---|
| `amazon_connected-account_mcp_auth_failures_total` | counter | error_code | mcp |
| `amazon_connected-account_mcp_scope_failures_total` | counter | error_code, actor_type | mcp |
| `amazon_connected-account_mcp_rate_limited_total` | counter | actor_type, error_code | mcp |
| `amazon_connected-account_mcp_protocol_failures_total` | counter | error_code, actor_type | mcp |
| `amazon_connected-account_mcp_tool_results_total` | counter | tool, result, actor_type | mcp |
| `amazon_connected-account_mcp_tool_duration_seconds` | histogram | tool, result, actor_type | mcp |
| `amazon_connected-account_account_access_rejections_total` | counter | actor_type, error_code | mcp |
| `amazon_connected-account_lwa_refresh_total` | counter | result | mcp |
| `amazon_connected-account_lwa_refresh_rotation_total` | counter | result, error_code（失败时） | mcp |
| `amazon_connected-account_redis_lwa_lock_total` | counter | result, error_code（超时时） | mcp |
| `amazon_connected-account_redis_lwa_lock_wait_seconds` | histogram | result | mcp |
| `amazon_connected-account_sp_api_errors_total` | counter | operation, error_code | mcp |
| `amazon_connected-account_sp_api_duration_seconds` | histogram | operation, result | mcp |
| `amazon_connected-account_readiness` | gauge | dependency | mcp |

Histogram buckets（秒）：`0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10,30`。

Queue/Worker 指标：**不适用**（当前无异步队列；引入队列前禁止虚构）。

## 告警规则（PromQL 等价）

| 告警 | 表达式（示意） | for | 级别 | 处置 |
|---|---|---|---|---|
| AuthFailureRate | `rate(amazon_connected-account_mcp_auth_failures_total[5m]) > 1` | 10m | warning | 检查 `connected-account.jwtKeys`、issuer/audience/kid/Scope 和签发方时钟；确认非攻击 |
| AccountAccessRejections | `sum(rate(amazon_connected-account_account_access_rejections_total[5m])) > 0.2` | 15m | warning | 查 Binding/Grant/Credential active 状态；禁止查询或输出 Owner ID |
| LwaRefreshFailures | `rate(amazon_connected-account_lwa_refresh_total{result="error"}[5m]) > 0.2` | 10m | critical | 查 LWA 凭证与 RT；禁止日志搜 Token |
| RefreshRotationConflict | `rate(amazon_connected-account_lwa_refresh_rotation_total{error_code="conflict"}[5m]) > 0` | 10m | warning | 检查同 Credential revision 的并发 refresh 和 Redis coordination |
| RedisLockTimeout | `rate(amazon_connected-account_redis_lwa_lock_total{error_code="timeout"}[5m]) > 0` | 5m | critical | 检查 Redis 延迟、lock TTL 和 LWA exchange 时长 |
| RedisLockWaitP95 | `histogram_quantile(0.95, sum by (le) (rate(amazon_connected-account_redis_lwa_lock_wait_seconds_bucket[5m]))) > 1` | 15m | warning | 检查 refresh 惊群，不提高 TTL 掩盖慢请求 |
| SpApi429 | `rate(amazon_connected-account_sp_api_errors_total{error_code="rate_limited"}[5m]) > 0.5` | 15m | warning | 降采样、检查 autoPage、限流 |
| ReadinessDown | `amazon_connected-account_readiness == 0` | 5m | critical | 检查 PostgreSQL/Redis/LWA/Token Store/加密密钥 |
| ToolErrorSpike | `sum(rate(amazon_connected-account_mcp_tool_results_total{result="error"}[5m])) > 1` | 15m | warning | 按 tool label 分流 |

Annotation 只允许：runbook 链接、服务名、稳定 error_code。禁止 issuer/employee/seller/request_id。

## 灰度稳定窗口

按 `Admin Session/Test Agent 管理 → shared Binding → Test Agent MCP` 三阶段切流；每阶段至少连续 24 小时满足：

- readiness 未持续为 0，Redis lock timeout 与 Refresh rotation conflict 均为 0；
- LWA error 和 SP-API 429 未触发上述告警；
- Account Policy rejection 与 MCP Scope rejection 能由预期负向测试或已知无权调用解释；
- `audit_log` 中 OAuth/Binding/Agent 写操作无未解释的 `failed`，且没有 Token/Owner identity 泄漏。

没有真实请求量时不能用“零错误”冒充稳定窗口；必须在 staging/Sandbox 产生 Employee JWT 与 Test Agent 两类代表性流量。

## 恢复验证

触发后：修复依赖 → 确认 `/readyz` ready → metrics gauge 恢复 1 → 告警 resolve。  
演练记录只保留时间戳、告警名、结论。
