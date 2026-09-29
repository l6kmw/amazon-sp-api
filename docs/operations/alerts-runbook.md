# Amazon ConnectedAccount 指标与告警 Runbook

指标前缀：`amazon_connected-account_`。抓取端点：各进程 `GET /internal/metrics`（**仅 loopback**；公网 404）。

## 指标清单（冻结）

| 指标 | type | labels | owner |
|---|---|---|---|
| `amazon_connected-account_mcp_auth_failures_total` | counter | error_code | mcp |
| `amazon_connected-account_mcp_scope_failures_total` | counter | error_code, actor_type | mcp |
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
| AuthFailureRate | `rate(amazon_connected-account_mcp_auth_failures_total[5m]) > 1` | 10m | warning | 检查 `connectedAccount.jwtKeys`、issuer/audience/kid/Scope 和签发方时钟；确认非攻击 |
| AccountAccessRejections | `sum(rate(amazon_connected-account_account_access_rejections_total[5m])) > 0.2` | 15m | warning | 查 Binding/Grant/Credential active 状态；禁止查询或输出 Owner ID |
| LwaRefreshFailures | `rate(amazon_connected-account_lwa_refresh_total{result="error"}[5m]) > 0.2` | 10m | critical | 查 LWA 凭证与 RT；禁止日志搜 Token |
| RefreshRotationConflict | `rate(amazon_connected-account_lwa_refresh_rotation_total{error_code="conflict"}[5m]) > 0` | 10m | warning | 检查同 Credential revision 的并发 refresh 和 Redis coordination |
| RedisLockTimeout | `rate(amazon_connected-account_redis_lwa_lock_total{error_code="timeout"}[5m]) > 0` | 5m | critical | 检查 Redis 延迟、lock TTL 和 LWA exchange 时长 |
| RedisLockWaitP95 | `histogram_quantile(0.95, sum by (le) (rate(amazon_connected-account_redis_lwa_lock_wait_seconds_bucket[5m]))) > 1` | 15m | warning | 检查 refresh 惊群，不提高 TTL 掩盖慢请求 |
| SpApi429 | `rate(amazon_connected-account_sp_api_errors_total{error_code="rate_limited"}[5m]) > 0.5` | 15m | warning | 降低 ConnectedAccount 调用频率并检查 autoPage 与 Amazon 配额；Provider 不做本地限流 |
| ReadinessDown | `amazon_connected-account_readiness == 0` | 5m | critical | 检查 PostgreSQL/Redis/LWA/Token Store/加密密钥 |
| ToolErrorSpike | `sum(rate(amazon_connected-account_mcp_tool_results_total{result="error"}[5m])) > 1` | 15m | warning | 按 tool label 分流 |

Annotation 只允许：runbook 链接、服务名、稳定 error_code。禁止 issuer/employee/seller/request_id。

## 工具失败事件与持久化告警

`tools/call` 即使以 HTTP 200 返回，只要 MCP 结果为 `isError=true`，也必须产生以下同一 `request_id` 的结构化记录：

- `mcp.request.completed`：`result=error`，并包含 `tool` 与稳定 `error_code`；
- `mcp.tool.failed`：包含 `tool`、`actor_type`、哈希后的 `actor_id_hash`、`result=error` 与稳定 `error_code`；
- PostgreSQL `amazon_sp_api.audit_log`：`action=mcp.tool.failed`、`resource_type=mcp_tool`、`result=failed`，并保存同一 `request_id`。

管理 Dashboard 的“最近错误 / 告警”统计过去 24 小时所有 `audit_log.result='failed'` 记录。有告警时从 Dashboard 进入“审计日志”，按 Request ID 精确查询；也可直接筛选结果为 `failed`。原始 Employee ID、Seller ID、Token 和工具输入不得写入普通 stdout、PostgreSQL 审计或告警；唯一例外是完整 `tools/call` arguments 独立写入受限 JSONL，并在 168 小时后删除。

若 PostgreSQL 告警写入失败，工具仍返回原始 MCP 错误，同时 stdout 记录 `mcp.alert.persist_failed`。这表示持久化告警链路本身异常，应按同一 `request_id` 立即检查 PostgreSQL；不得将该事件视为业务工具的第二个错误。

## Request ID 关联排障

先从客户端错误 envelope 读取 `error.request_id`，再按相同值关联请求、工具和上游日志：

```bash
REQUEST_ID='req_REPLACE_ME'
docker compose logs --since 24h amazon-sp-api \
  | jq -c --arg request_id "$REQUEST_ID" 'select(.request_id == $request_id)'
```

在管理端“审计日志”中输入同一个 Request ID，可确认失败是否已经持久化。LWA、SP-API、Redis 与请求收尾记录在同一 AsyncLocalStorage 请求上下文中，调用点传入的其他 ID 不得覆盖当前 `request_id`。

## Docker 日志保留边界

Compose 使用 Docker `json-file` 驱动，每个日志文件最大 `10m`，最多保留 `5` 个文件。stdout 只用于近期关联排障，轮转或容器重建后不作为历史告警依据；跨容器的失败告警以 PostgreSQL `audit_log` 为准。完整 `tools/call` arguments 使用独立受限 JSONL 保留 168 小时，不进入 stdout 或 PostgreSQL，也不改变 Docker `10m` × `5` 的轮转配置。部署后确认实际配置：

参数文件位于 `${storage.dataDirectory}/logs/mcp-arguments/mcp-arguments-YYYY-MM-DDTHH.jsonl`，按 UTC 小时切换，目录权限为 `0700`、文件权限为 `0600`。服务启动时及之后每小时清理创建时间超过 168 小时的匹配文件；目录内其他文件保持不变。

```bash
docker inspect amazon-sp-api \
  --format '{{json .HostConfig.LogConfig}}'
```

预期包含 `Type=json-file`、`max-size=10m`、`max-file=5`。不要把 Docker 日志目录挂载进应用容器，也不要在 stdout 或审计表中记录凭据。

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
