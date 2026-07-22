# Amazon SP-API ConnectedAccount 账号型 MCP 设计规格

> 状态：M0 规格冻结（2026-07-22）。文档不包含真实 Secret、Token、授权码或生产数据。
>
> 唯一规范来源：`build-connected-account-account-mcp` skill 及其 references/assets。
>
> 发布约束：`CONNECTED_ACCOUNT_ENABLED=false`；外部开放（M5）保持锁定。

## 1. 目标与边界

- Provider key：`amazon-sp-api`
- MCP 服务名称：`amazon-sp-api-mcp`
- 外部平台：Amazon Selling Partner API（LWA OAuth + SP-API）
- 目标用户与主要任务：ConnectedAccount Employee 发现、授权、绑定并调用其 Amazon 卖家账号的只读经营数据。
- 本期包含：Employee JWT、Connected Account Protocol v1、规范 `account_id`、身份与账号基础工具、现有只读业务工具按 principal 兼容迁移、PostgreSQL/Redis 生产存储。
- 本期不包含：Amazon 业务写操作、买家 PII、Amazon Ads API、legacy 入口最终下线、外部卖家开放。
- 第三方业务数据 source of truth：Amazon SP-API（订单、库存、Listings、Marketplace）。本地只保存连接、绑定、授权状态和加密凭据。

迁移期间并存两条路径：

| 路径 | 身份 | 账号参数 | 状态 |
|---|---|---|---|
| 旧实现兼容路径 | 旧实现 `oat_*`，可选受控 legacy token | `sellingPartnerId` | 兼容窗口保留 |
| ConnectedAccount 路径 | 短期 HS256 Employee JWT | `account_id` | feature flag 默认关闭 |

ConnectedAccount principal 不得退化到旧实现路径；旧实现 principal 也不能伪装成 ConnectedAccount Employee。

## 2. 身份与信任边界

- ConnectedAccount issuer：配置项 `CONNECTED_ACCOUNT_JWT_KEYS`/`CONNECTED_ACCOUNT_JWT_ISSUERS` 中与 `kid` 绑定的精确值。
- JWT audience：`CONNECTED_ACCOUNT_JWT_AUDIENCE`，生产建议 `amazon-sp-api-account-service`。
- Employee 稳定标识：已验证的 `iss + sub`。
- 内部 workspace：`jwt-employee:` + Base64URL(SHA-256(issuer) 前 12 字节) + `:` + subject；该值作为 ConnectedAccount `tenantId`/owner workspace。
- ConnectedAccount JWT 最长 5 分钟，时钟偏差最多 30 秒。
- Header 必须为 `alg=HS256` 且包含受信任 `kid`；payload 必须包含 `iss/aud/sub/jti/iat/nbf/exp` 与 Scope。
- JWT key 通过 `kid -> issuer + audience + secret` 服务端信任表选择，Secret 至少 32 字节高熵材料。
- `/connected-account/v1/auth/check` 接受四类协议 Scope 中任一项；MCP 调用要求 `mcp:invoke`，账号管理要求 `connected_accounts:manage`。
- 禁止客户端覆盖：tenant、user、employee、workspace、owner、issuer、connection owner。
- 管理员/运维诊断若未来需要强刷，必须独立认证链路，不得出现在 ConnectedAccount Employee catalog。

现有旧实现身份继续由 `LEGACY_IDENTITY_VALIDATION_URL` 验证并返回 `tenantId`。两条认证链路共享 HTTP 服务，但 principal 类型和授权规则分离。

## 3. 外部账号与凭据

### 冻结决策

| 字段 | 冻结值 |
|---|---|
| 外部账号业务唯一键（OAuth 凭据真相） | 本服务仅 Amazon：`selling_partner_id` 全局主键（语义等价固定 `provider_key=amazon-sp-api` + SP-ID） |
| ConnectedAccount 元数据账号键 | `account_id`（Provider 生成的不透明 ID） |
| MCP 规范账号参数 | `account_id` |
| 外部 Seller ID | 仅人工核对，不得作为 ConnectedAccount 工具授权键 |
| 一员工多账号 | 是（`multiAccount=true`） |
| 一 Grant 多员工 | 否（`sharedEmployeeBinding=false`） |
| 独立所有者授权 | **否**（`independentOwnerAuthorization=false`） |

### `independentOwnerAuthorization=false` 裁决

Amazon 应用对同一 `selling_partner_id` 只保存一份 Refresh Token。`oauth_connection` 以 `selling_partner_id` 为主键；跨 tenant 重新授权在条件更新失败时返回冲突（`ConflictError` / 409 语义），不得静默覆盖他方凭据。

因此 discovery 冻结为 `independentOwnerAuthorization: false`，与 OAuth runtime 和全局凭据主键一致。

冲突语义：

1. 同一 tenant 再次授权同一 Seller：更新该 tenant 的加密 Refresh Token 与授权时间（幂等重授权）。
2. 不同 tenant 授权同一 Seller：拒绝，返回冲突；不泄露对方 tenant/employee。
3. ConnectedAccount 层 `external_account_credential` 仍按 `owner_workspace_id` 关联 Grant/Binding；有效调用必须以 active Binding + Grant + Account 联合校验通过为准。

> 若未来产品要求 true，必须先完成 `oauth_connection` 复合所有权迁移、唯一约束、callback 与回滚路径，再改 capability；在三方一致前不得开启 `CONNECTED_ACCOUNT_ENABLED`。

### 凭据与加密

- 凭据类型：LWA Refresh Token（长期）+ Access Token（短期缓存）。
- Access Token 仅 Redis/进程缓存；Refresh Token 加密持久化。
- **上线阻断**：当前密文为 `legacy-unversioned` AES-256-GCM JSON envelope（`algorithm/ciphertext/iv/tag`），**没有** `version/key_id`。M2-T2 完成版本化 envelope 与渐进轮换前，正式开启 ConnectedAccount 为阻断。
- 设计目标格式：`version | key_id | algorithm | nonce/iv | ciphertext | authentication_tag`，AAD 绑定 version/key_id/provider/credential ID。
- JWT、Refresh Token、Access Token、code/state 永不进入 MCP 输出、浏览器、日志或指标。

## 4. Connected Account Protocol v1

### Discovery

```json
{
  "protocolVersion": "1.0",
  "providerKey": "amazon-sp-api",
  "displayName": "Amazon SP-API",
  "authorizationFlow": "redirect",
  "capabilities": {
    "multiAccount": true,
    "sharedEmployeeBinding": false,
    "independentOwnerAuthorization": false,
    "remark": true,
    "refresh": true,
    "unbind": true
  },
  "runtime": {
    "listAccountsTool": "amazon_list_accounts",
    "accountIdArgument": "account_id"
  }
}
```

Capability 与实现对应关系（全部必须有路由/实现/测试）：

| Capability | 路由或行为 | 实现状态 |
|---|---|---|
| multiAccount | Binding 多账号 + list/lookup | 已实现 |
| sharedEmployeeBinding=false | Grant 默认仅 owner Employee 绑定 | 已实现 |
| independentOwnerAuthorization=false | OAuth 全局 SP-ID 排他 + 跨 tenant 冲突 | 已实现并与 discovery 对齐 |
| remark | `PUT .../remark`，≤80 Unicode | 已实现 |
| refresh | `POST /connected-account/v1/accounts/refresh` | 已实现 |
| unbind | `DELETE .../account-bindings/{connectionId}` | 已实现 |

Discovery 仅在 `CONNECTED_ACCOUNT_ENABLED=true` 时发布。

### 固定接口

| Method | Path | Scope | 作用 |
|---|---|---|---|
| GET | `/.well-known/connected-account` | 公开 | 发现清单 |
| GET | `/connected-account/v1/auth/check` | 任一协议 Scope | 身份与配置检查 |
| GET | `/connected-account/v1/accounts` | `connected_accounts:manage` | 当前员工账号 |
| POST | `/connected-account/v1/accounts/refresh` | `connected_accounts:manage` | 刷新账号状态 |
| POST | `/connected-account/v1/accounts/lookup` | `connected_accounts:manage` | 按 connection 查询，去重后最多 100 |
| POST | `/connected-account/v1/authorization-attempts` | `connected_accounts:manage` | 创建授权尝试 |
| GET | `/connected-account/v1/authorization-attempts/{attemptId}` | `connected_accounts:manage` | 查询当前员工 Attempt |
| POST | `/connected-account/v1/account-bindings` | `connected_accounts:manage` | 创建绑定 |
| PUT | `/connected-account/v1/account-bindings/{connectionId}/remark` | `connected_accounts:manage` | 更新备注 |
| DELETE | `/connected-account/v1/account-bindings/{connectionId}` | `connected_accounts:manage` | 解绑当前员工 |
| DELETE | `/connected-account/v1/connections/{connectionId}` | `connected_accounts:manage` | 断开 Grant |

字段约定：camelCase、`protocolVersion=1.0`、时间 RFC3339 UTC。

### 授权流程

1. 服务端以当前 `issuer + employeeId` 创建短期 Attempt（201）。
2. 生成至少 128 bit 随机 state，只保存摘要并绑定 Attempt、Employee、redirect 和过期时间。
3. 返回首方授权入口（`api.example.com`），不把所有权参数交给浏览器。
4. OAuth 服务跳转 Amazon Seller Central；回调原子消费 state。
5. 交换凭据并识别 `sellingPartnerId`，按全局排他规则写入 `oauth_connection`。
6. 创建/更新 External Account 与 Connection Grant，完成 Attempt；绑定请求再创建 Employee Binding。
7. 完成页仅向配置的 ConnectedAccount Origin 发送 `type/attemptId/status`，`targetOrigin` 精确匹配；轮询可重复读取结果。

### 状态与删除语义

| 实体 | 状态 | 唯一/幂等约束 |
|---|---|---|
| Authorization Attempt | `pending/active/failed/expired` | `issuer + employee_id + attempt_id`；state 只消费一次 |
| External Account Credential（ConnectedAccount 元数据） | `active/revoked/error` | `provider_key + external_account_id + owner_workspace_id` |
| OAuth Connection（Refresh Token 真相） | `active/disconnected` | `selling_partner_id` 全局主键；跨 tenant 冲突 |
| Connection Grant | `active/disconnected` | `issuer + connection_id` |
| Employee Binding | `active/unbound` | `issuer + employee_id + connection_id` |

**删除语义（不可混淆）**

| 操作 | 作用 | 不影响 |
|---|---|---|
| Unbind | 仅停用当前 Employee 的 Binding | 其他 Employee、Grant、OAuth 凭据 |
| ConnectedAccount Disconnect | 停用当前 Grant 及其 Binding | OAuth 凭据、其他 issuer 的实体 |
| 旧实现 Disconnect（legacy 工具） | 断开旧实现 tenant 的卖家连接 | 不得伪装为 ConnectedAccount Disconnect |
| Credential Revoke | 标记供应商凭据失效，阻止引用它的 Grant 调用 | 历史审计记录 |
| Physical Delete | 仅在无有效引用且保留策略允许时执行 | 默认不自动触发 |

## 5. 数据模型与存储

```text
employee_registry(issuer, employee_id, workspace_id, first_seen_at, last_seen_at)
external_account_credential(account_id, provider_key, external_account_id,
  owner_workspace_id, display_name, status, timestamps)
connection_grant(issuer, connection_id, account_id, owner_employee_id, status, timestamps)
employee_account_binding(issuer, employee_id, workspace_id, connection_id,
  status, remark, bound_at, updated_at)
authorization_attempt(issuer, employee_id, attempt_id,
  status, connection_id, error_code, expires_at, consumed_at)
oauth_connection(selling_partner_id PK, tenant_id, refresh_token envelope,
  status, connected-account_attempt_id, timestamps)
```

- PostgreSQL 是不可丢失状态的生产真相源。
- Redis 只用于短期 state/cache/lock。
- 文件 Token Store 仅本地/回滚兼容，不是生产唯一真相源。
- 所有 ConnectedAccount 账号查询必须联合验证 Binding、Grant 和 Account 的 issuer、employee 与 active 状态。
- 跨 issuer 的相同 `sub` 必须完全隔离。

## 6. MCP 工具目录

### ConnectedAccount Employee catalog（上线边界）

| Tool | 账号参数 | 成功输出 | 副作用 |
|---|---|---|---|
| `amazon_get_identity` | 无 | 安全身份摘要 | read-only |
| `amazon_list_accounts` | 无 | 当前 principal 可用的规范账号列表 | read-only |
| 只读业务工具 | 仅 `account_id` | 各自严格 output Schema + structuredContent | read-only |

ConnectedAccount catalog **不得**注册：

- `amazon_create_authorization_url`
- `amazon_create_renewal_url`
- `amazon_list_connections`
- `amazon_disconnect_connection`

账号生命周期只通过 `/connected-account/v1` Attempt/Binding/Unbind/Disconnect 管理。

### 旧实现兼容 catalog

可在兼容窗口保留上述连接管理工具，参数使用 `sellingPartnerId`，不得伪装成 ConnectedAccount principal。

### 写工具

**当前没有 Amazon 业务写工具。** 精确确认值、业务幂等、revision、operation unknown 对 ConnectedAccount principal catalog 为“不适用”。未来任何写工具必须另立专项设计，并自动恢复为阻断验收项。

成功响应必须同时返回通过 `outputSchema` 的 `structuredContent` 与相同安全投影文本 JSON。失败必须 `isError=true`、文本 JSON 错误 envelope、无 `structuredContent`（M1 契约严格化）。

## 7. 错误与恢复

公开错误 envelope（M1-T2 目标）：

```json
{ "error": { "code": "...", "tool": "...", "message": "...", "http_status": 400, "request_id": "...", "next_action": "..." } }
```

稳定 code：`invalid_tool_arguments`、`unauthorized`、`forbidden`、`resource_not_found`、`resource_changed`、`conflict`、`upstream_error`、`timeout`、`configuration_required`、`internal_error`、扩展 `rate_limited`。

Token 恢复：只有 Amazon 明确的 access token 无效/过期响应可触发锁内强制刷新并原样重试一次。网络错误、5xx、权限不足、业务校验失败不得触发刷新。`amazon_connection_health` 的无条件强刷必须在 M2-T1 整改。

## 8. 并发、幂等与异步操作

- Attempt 创建、state 消费、Grant 和 Binding 创建依赖数据库唯一约束。
- Token 刷新同时使用进程 singleflight 与 Redis 分布式锁；锁内再次检查共享 Token，并用 owner token + Lua 安全释放。
- 当前业务工具均为只读，不新增写操作幂等键或确认值。
- 当前无异步 Queue/Worker；不得虚构队列指标。
- 未来写操作必须使用 `workspace + account_id + operation + idempotency_key` 唯一键和请求指纹。

## 9. 安全与隐私

- Secret 仅来自只读部署环境或 Secret Manager；不进入仓库、镜像层或文档。
- state 至少 128 bit、短 TTL、摘要存储、原子单次消费。
- `CONNECTED_ACCOUNT_ALLOWED_ORIGINS` 只接受精确 HTTP/HTTPS Origin，生产禁止 `*`，生产 origin 必须 HTTPS。
- 当前工具不接受任意 URL、文件或 Webhook 输入；只读验收脚本的 URL 校验适用并有测试。
- 日志只允许 request ID、tool、结果、耗时、脱敏 actor 类型和稳定错误码（M4 事件字典收紧）。
- 日志禁止 Authorization、JWT、Token、Secret、Cookie、code/state、完整 URL query、业务响应和内部 tenant。

## 10. 部署与可观测性

- 公网 origin：`https://api.example.com`
- MCP path：`/mcp/amazon`（Nginx 映射到服务 `/mcp`）
- 健康：`/healthz`、`/mcp/healthz` 为 liveness；`/readyz` 为 readiness（PostgreSQL、Redis、OAuth、加密 key、identity）。
- `CONNECTED_ACCOUNT_ENABLED=false` 为默认值和即时回滚开关。
- JWT 轮换：Provider 双信任新旧 key，ConnectedAccount 切换后等待至少 JWT 最大寿命 5 分钟 + 30 秒偏差，再移除旧 key（M4-T3 演练）。
- 凭据加密 key 轮换：依赖 M2 版本化 envelope；未完成前为上线阻断。
- Docker YAML 需表达 PostgreSQL、Redis、ConnectedAccount、keyring（M3）。

## 11. 验收

- 自动化：根目录与子项目 `npm test`、`npm run typecheck`、`npm run build`。
- 只读验收：`scripts/verify_connected-account_account_mcp.py`（来源 skill 脚本，见 M0-T2）。
- 必测：两个 issuer 相同 sub、同 issuer 两个 Employee、一个 Employee 多账号、非所属 `account_id`、伪造 identity 字段。
- 必测：授权、重复回调、绑定、重复绑定、解绑和断开语义。
- 必测：成功 output Schema、失败无 structuredContent、日志无 Secret。
- 版本化证据：`docs/acceptance/<release-id>.md`。
- **已知阻断**：
  1. Refresh Token envelope 无 `version/key_id`（M2-T2）。
  2. 全工具 output Schema / 错误契约未完全符合 ConnectedAccount 新契约（M1）。
  3. Docker YAML 未完整表达生产 keyring/ConnectedAccount（M3）。
  4. JWT 轮换演练与指标告警未闭环（M4）。
- `CONNECTED_ACCOUNT_ENABLED` 只有在验收矩阵阻断项为 0 且独立评分达标后才可请求用户解锁外部阶段。
