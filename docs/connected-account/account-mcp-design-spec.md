# Amazon SP-API ConnectedAccount 账号型 MCP 当前设计规格

> 当前架构：根目录单包、单 Node 进程、单端口 `8789`。OAuth、MCP、ConnectedAccount、存储与健康检查共享同一运行时。
>
> 业务边界：Seller、非 Restricted、非 Vendor、未弃用且不改变 Amazon 业务状态的只读能力。

## 1. 身份与信任边界

MCP 接受两类相互独立的凭据：服务在本进程内使用 `connectedAccount.jwtKeys` 验签的 ConnectedAccount Employee JWT，以及管理控制面数据库中仅存 SHA-256 Hash 的 `oat_*` Test Agent Token。两类凭据解析为不同 Principal，不依赖、不调用外部身份 HTTP 接口；旧共享 Bearer Token、`IdentityVerifier`、`LegacyIdentityVerifier`、`legacy` principal 和 `legacy_agent` 类型仍保持删除。

- Header 必须为 `alg=HS256` 且包含已配置的 `kid`。
- payload 必须包含与密钥绑定的 `iss`、配置的 `aud`、稳定 `sub`、`jti`、`iat`、`nbf`、`exp` 以及端点要求的 Scope。
- JWT 最长五分钟，允许时钟偏差不超过 30 秒。`kid -> issuer + audience + secret` 的选择是服务端信任决策。
- `/connected-account/v1/auth/check` 和 `/connected-account/v1/*` 生命周期接口只接受 Employee JWT；MCP 调用要求服务端 Scope `mcp:invoke`，目录可使用 `mcp:catalog`，账号管理要求 `connected_accounts:manage`。
- `oat_*` Token 仅在 PostgreSQL 与私密 Admin Session Secret 同时配置时启用；每次 MCP 请求都查询 active Agent 和当前 Token Hash，disable、rotate、revoke 立即失效。
- 未配置 Employee JWT verifier 时 Employee JWT 失败关闭；未配置安全管理控制面时 Test Agent Token 失败关闭；OAuth、`/healthz` 和 `/readyz` 继续服务。

Employee 稳定身份为已验证的 `iss + sub`。内部 workspace 是 `jwt-employee:` + Base64URL(SHA-256(issuer) 前 12 字节) + `:` + subject。Test Agent 固定属于管理员租户 `tenant-1`，但客户端不得覆盖 tenant、agent、employee、workspace、owner、issuer、Credential 或 connection owner。

## 2. 账号模型与归属

| 概念 | 冻结值 |
|---|---|
| Provider key | `amazon-sp-api` |
| Account 唯一键 | `provider_key + issuer_scope + selling_partner_id` |
| ConnectedAccount 规范账号参数 | `account_id` |
| 一员工多账号 | 支持 |
| 一 Grant 多员工 | 支持，同 issuer 多 active Binding |
| 独立所有者授权 | 支持，每个 Owner 独立 Credential/Grant/OAuth 行 |

业务工具只接受 `account_id`。统一 `AccountAccessPolicy` 对 Employee 联合验证 `issuer + employee_id` 的 active Binding、Grant、Account 和 Credential；对 Test Agent 只从服务端稳定选择 active Grant Credential。Policy 同时返回内部 `credential_owner_id` 供 LWA/SP-API 调用，任何公共响应和工具输入都不暴露 Owner、Credential 或 Selling Partner ID 选择权。

同一 issuer 的多个 Owner 授权同一 Seller 时复用一个 Account，但各自保留独立 Credential、Grant 和 OAuth 行；一个 Owner 的 CAS、Disconnect 或重新授权不影响另一个 Owner。不同 issuer 同 Seller 可独立授权。

## 3. Connected Account 协议

Discovery 仅在 `connectedAccount.enabled=true` 时发布，主要能力为 `multiAccount=true`、`sharedEmployeeBinding=true`、`independentOwnerAuthorization=true`、`remark=true`、`refresh=true`、`unbind=true`。

| Method | Path | Scope | 作用 |
|---|---|---|---|
| GET | `/.well-known/connected-account` | 公开 | 发现清单 |
| GET | `/connected-account/v1/auth/check` | 任一协议 Scope | 身份与配置检查 |
| GET | `/connected-account/v1/accounts` | `connected_accounts:manage` | 当前 Employee 账号 |
| POST | `/connected-account/v1/accounts/refresh` | `connected_accounts:manage` | 刷新账号状态 |
| POST | `/connected-account/v1/accounts/lookup` | `connected_accounts:manage` | 批量查询并去重 |
| POST | `/connected-account/v1/authorization-attempts` | `connected_accounts:manage` | 创建 Amazon 授权尝试 |
| GET | `/connected-account/v1/authorization-attempts/{attemptId}` | `connected_accounts:manage` | 轮询当前 Employee Attempt |
| POST | `/connected-account/v1/account-bindings` | `connected_accounts:manage` | 创建绑定 |
| PUT | `/connected-account/v1/account-bindings/{connectionId}/remark` | `connected_accounts:manage` | 更新备注 |
| DELETE | `/connected-account/v1/account-bindings/{connectionId}` | `connected_accounts:manage` | 解绑当前 Employee |
| DELETE | `/connected-account/v1/connections/{connectionId}` | `connected_accounts:manage` | 断开 Grant |

MCP 不注册创建授权、授权轮询、列出连接、续期或断开连接工具。账号生命周期只通过上述 `/connected-account/v1/*` 协议路由管理。

## 4. OAuth 与凭据

1. 当前 Employee 创建短期 Attempt。
2. 服务生成至少 128 bit 随机 state，只存摘要，并绑定 Attempt、Employee、redirect 和过期时间。
3. 同一进程内的 OAuth Router 跳转 Amazon；回调原子消费 state。
4. 交换 LWA 凭据并识别 Selling Partner ID；按 `(issuer_scope, selling_partner_id)` 串行复用 Account，并为 Owner 写独立 Credential/OAuth 行。
5. 完成 Owner Grant 和 Attempt；绑定请求创建 Employee Binding，共享只增加 Binding，不复制 Credential。

Refresh Token 使用 AES-256-GCM v2 envelope 加密持久化，并继续解密 legacy/v2 历史数据。旧单密钥作为 `keyId: k0` 放入 keyring 即可，无需为升级预先重加密。Access Token 只保存在 Redis/进程短期缓存。

HTTP Authorization Header、已验证的 ConnectedAccount JWT、服务持有的 Refresh/Access Token、OAuth code/state 和预签名 URL 永不复制到 MCP 输出、浏览器页面、普通 stdout、PostgreSQL、指标或告警。唯一日志例外是调用者提交的完整 `tools/call` arguments 会在 Schema 校验前写入受限 JSONL，可能包含调用者提供的 Token 类值，并按创建时间保留 168 小时。

## 5. Seller 只读 MCP 目录

MCP 保留安全身份/账号工具、现有订单/库存/Marketplace/Listings/经营快照工具，并注册：

- `amazon_get_read_capabilities`：返回 action、Amazon 角色、区域和 `unknown/available/permission_required`，不批量探测 Amazon。
- 17 个 `amazon_<domain>_read` 领域工具：Seller、Catalog、Listings、Orders、Inventory、Pricing、Analytics、Finances、Warehousing、Fulfillment、Shipping、Services、A+ Content、Reports、Data Kiosk、Feeds、Integrations。

Listings 固定启用，无 feature flag。每个领域只接受生成的 action 枚举，不接受任意 URL、path、method 或 Header。完整基线、领域、角色和排除原因见 [`../SP-API-READ-CAPABILITIES.md`](../SP-API-READ-CAPABILITIES.md)。

Amazon 403 被转换为 `AMAZON_ROLE_REQUIRED`，只返回 operation 和所需角色，不回显 Amazon 原始响应。所有成功结果必须通过 output schema，错误使用稳定 envelope，不将错误包装成成功数据。

## 6. 数据安全

- 请求 path/query/body 和响应都按冻结 Amazon 模型验证。响应先删除模型外字段，再删除 buyer、recipient、姓名、地址、电话、邮箱、支付标识和其他 PII。
- Orders v2026 禁止 `BUYER`、`RECIPIENT`、`PACKAGES`、`PAYMENT` 数据段。
- Reports 只允许 Seller 非受限 report type；Feeds 只允许安全文本类型的已有文档。
- Data Kiosk 只允许冻结 Seller schema，禁止 mutation、subscription、introspection、未知 schema，并限制长度、深度和字段数。
- Reports、Data Kiosk 和文本 Feed 文档按页临时读取，单页最多 200 条或 256 KiB，游标 15 分钟过期。不落盘、不记录正文、不返回预签名 URL。
- 文档游标使用从 credential keyring 派生的独立 AES-GCM 密钥，绑定 issuer/employee/account/operation/job/document/offset/expiry，支持密钥轮换并拒绝跨员工重放。

## 7. 缓存、上游限流响应和重试

- Provider 不对 MCP 入口实施请求/并发限流，也不根据 Amazon usage-plan Header 本地排队；调用频率由 ConnectedAccount 端统一控制。
- LWA 本地 cache、in-flight 和 Redis access/lock key 使用 `credential_id + refresh_token_revision`；共享 Employee 不按调用者 workspace 重复刷新。
- 账号连接缓存 30 秒，Amazon 区域缓存 24 小时。这些是安全常量，不是 YAML 配置。
- Amazon 返回 429 时映射为 `rate_limited`。GET 和明确幂等的查询可按有界退避重试；创建 Report/Data Kiosk 任务遇到结果不确定的失败时不自动重放。
- 只有 Amazon 明确的 Access Token 失效可触发锁内强制刷新并重试一次；权限错误、5xx 或业务校验失败不刷新凭据。

## 8. 存储与生命周期

PostgreSQL 是生产不可丢失状态的真相源，Redis 用于短期 state/cache/lock，文件 Token Store 仅用于本地和回滚兼容。ConnectedAccount 启用时必须配置 PostgreSQL、Redis、credential keyring、HTTPS Origin 和 JWT keyring。

单进程只创建一个 PostgreSQL Pool 和一个 Redis Client，注入 OAuth、Token/Intent Store、ConnectedAccount 和 MCP。SIGTERM/SIGINT 时先停止接收请求，再关闭 Redis、PostgreSQL 和 SQLite 等资源。

`/readyz` 只检查 LWA、Token Store、加密密钥以及已配置的 PostgreSQL/Redis，不存在 identity 检查。

## 9. 验收边界

- 合法 Employee JWT 与 active `oat_*` Test Agent Token 可通过同一 `/mcp` transport 列出/调用工具，但返回不同安全身份摘要；共享 Bearer、未知/disabled/rotated/revoked Agent Token、未知 kid、错误 issuer/audience/scope/签名/时间均必须失败。
- Employee 只能解析自己的 active Binding；Test Agent 只能使用服务端 `tenant-1` 管理视图中的 active Account/Grant/Credential；猜测或已撤销 `account_id` 均在任何 LWA/SP-API 调用前稳定拒绝。
- 服务启动和处理请求期间不访问 `host.docker.internal:8080`，`/readyz` 不包含 identity。
- 任意 URL/path/method、写 operation、Vendor、Restricted、弃用版本和 PII 参数必须在请求 Amazon 前被拒绝。
- 冻结基线 353 个 operation 逐一分类；未分类 operation 使 CI 失败。
- 每个领域覆盖工具发现、action 参数、账号隔离、区域、权限、429、Token 刷新和未知字段删除。
- Report/Data Kiosk/Feed 覆盖创建或任务查询、轮询、取消、GZIP、分页、游标过期、密钥轮换和跨 Employee 重放。
- 发布必须通过冻结 Bun 安装、全量测试、类型检查、构建、敏感信息扫描、Docker 构建和单进程冒烟。
