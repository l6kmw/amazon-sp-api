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
| `amazon_connected-account_lwa_refresh_total` | counter | result | mcp |
| `amazon_connected-account_sp_api_errors_total` | counter | operation, error_code | mcp |
| `amazon_connected-account_sp_api_duration_seconds` | histogram | operation, result | mcp |
| `amazon_connected-account_readiness` | gauge | dependency | mcp |

Histogram buckets（秒）：`0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10,30`。

Queue/Worker 指标：**不适用**（当前无异步队列；引入队列前禁止虚构）。

## 告警规则（PromQL 等价）

| 告警 | 表达式（示意） | for | 级别 | 处置 |
|---|---|---|---|---|
| AuthFailureRate | `rate(amazon_connected-account_mcp_auth_failures_total[5m]) > 1` | 10m | warning | 查 IdP/JWT 配置；确认非攻击 |
| LwaRefreshFailures | `rate(amazon_connected-account_lwa_refresh_total{result="error"}[5m]) > 0.2` | 10m | critical | 查 LWA 凭证与 RT；禁止日志搜 Token |
| SpApi429 | `rate(amazon_connected-account_sp_api_errors_total{error_code="rate_limited"}[5m]) > 0.5` | 15m | warning | 降采样、检查 autoPage、限流 |
| ReadinessDown | `amazon_connected-account_readiness == 0` | 5m | critical | 查 PG/Redis/OAuth/identity |
| ToolErrorSpike | `sum(rate(amazon_connected-account_mcp_tool_results_total{result="error"}[5m])) > 1` | 15m | warning | 按 tool label 分流 |

Annotation 只允许：runbook 链接、服务名、稳定 error_code。禁止 issuer/employee/seller/request_id。

## 恢复验证

触发后：修复依赖 → 确认 `/readyz` ready → metrics gauge 恢复 1 → 告警 resolve。  
演练记录只保留时间戳、告警名、结论。
