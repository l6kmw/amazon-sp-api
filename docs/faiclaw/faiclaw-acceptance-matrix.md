# Amazon SP-API ConnectedAccount 账号型 MCP 验收矩阵

> `通过` 必须有 example 自动化测试、请求/响应摘要或安全日志证据。不得记录 Token、Secret、授权码或带签名 URL。

| 阶段 | 类别 | 验收项 | 预期结果 | 当前证据 | 状态 |
|---|---|---|---|---|---|
| A | Discovery | `/.well-known/connected-account` | `protocolVersion=1.0`，字段与真实能力一致 | 2026-07-21 example 临时实例；skill 只读脚本通过 | 通过 |
| A | Discovery | runtime 工具映射 | `amazon_list_accounts` 存在，参数为 `account_id` | example 76/76；tools/list 存在工具与 output Schema | 通过 |
| A | JWT | 正确 JWT | auth/check 与 MCP 成功 | example 临时 JWT 实测 auth/check 200；MCP transport 成功 | 通过 |
| A | JWT | 未知 kid、错误签名、`alg=none` | 401，不泄露细节 | `test/connected-account.test.ts`，example 通过 | 通过 |
| A | JWT | issuer/audience 错误 | 401 | `test/connected-account.test.ts`，example 通过 | 通过 |
| A | JWT | 缺少 `jti/iat/nbf/exp` | 401 | `test/connected-account.test.ts`，example 通过 | 通过 |
| A | JWT | 超过 5 分钟、过期、未来签发 | 401，允许偏差不超过 30 秒 | `test/connected-account.test.ts`，example 通过 | 通过 |
| A | Scope | 四类 Scope | 每个端点只接受规定 Scope | auth/check 任一协议 Scope、MCP `mcp:invoke`、管理端点 `connected_accounts:manage` 均在 example 通过 | 通过 |
| A | MCP | Streamable HTTP 与 health | 可初始化、列工具，`/mcp/healthz` 200 | example 临时实例 + 76/76；公开只读脚本 health 通过 | 通过 |
| B | 隔离 | 两个 issuer 的相同 sub | 不同 Employee 和 workspace | `test/connected-account-accounts.test.ts` issuer 隔离，example 通过 | 通过 |
| B | 隔离 | 同 issuer 两个 Employee | Attempt、Binding、账号不串用 | Attempt/Grant/Binding/Account 联合隔离测试，example 通过 | 通过 |
| B | 隔离 | 伪造 tenant/user/employee | 不改变服务端 principal | 管理请求未知身份字段返回 400；归属只取已验证 principal | 通过 |
| B | Account | 一个 Employee 多账号 | API 与 MCP 列表均完整 | 两账号绑定列表与 MCP structuredContent 测试，example 通过 | 通过 |
| B | Account | 非所属 `account_id` | 所有业务工具均拒绝 | active Binding + Grant + Account 联合归属解析；10 个业务工具逐个返回 `NOT_CONNECTED` 且 SP-API 调用数为 0；example 84/84 | 通过 |
| B | Attempt | 创建与轮询 | 归属、TTL、状态正确 | pending/active/expired、跨 Employee 404，example 通过 | 通过 |
| B | Attempt | 重复回调/state 重放 | 只完成一次 | OAuth callback 重放返回 400；state/intent 仅存摘要 | 通过 |
| B | Binding | 重复绑定 | 幂等或稳定冲突 | 首次 201、重复 200 且 connection 不变 | 通过 |
| B | Binding | Unbind | 只影响当前 Employee | 重复解绑幂等；其他 Employee 不可访问 | 通过 |
| B | Connection | Disconnect | Grant 与相关 Binding 失效，不误删凭据 | 重复断开幂等；Grant/Binding 失效，OAuth 凭据保留 | 通过 |
| B | Callback | postMessage Origin | 仅允许配置 Origin | 未允许/缺失 Origin 返回 400；页面使用精确 targetOrigin | 通过 |
| B | Callback | 浏览器安全头 | CSP、no-referrer、no-store | OAuth `server.test.mjs` 检查 nonce CSP 与三个安全头 | 通过 |
| C | MCP | `amazon_get_identity` | 只返回安全身份摘要 | Legacy 与 ConnectedAccount structuredContent 均在 example 通过；无 tenant/issuer/Token | 通过 |
| C | MCP | `amazon_list_accounts` | 只返回规范账号 ID 和安全元数据 | ConnectedAccount 仅返回当前 Employee 的 active Binding/Grant/Account；example 通过 | 通过 |
| D | Schema | 输入 Schema | 类型、范围、枚举、未知字段、互斥关系正确 | ConnectedAccount 业务工具只暴露 `account_id`；旧实现只保留可选 `sellingPartnerId`；严格 Zod 拒绝未知字段 | 通过 |
| D | Schema | 成功输出 | structuredContent 通过 output Schema | M1-T1：全工具 outputSchema + 文本 JSON 与 structuredContent 同投影；列表统一 `items`；`tool-schemas.ts` 与 tests 通过 | 通过 |
| D | Error | 参数/业务失败 | `isError=true`、文本 JSON envelope、无 structuredContent | M1-T2：`{error:{code,tool,message,http_status,request_id,next_action}}`；`test/errors.test.ts` + tools 失败断言 | 通过 |
| D | Error | internal_error | 只返回 request ID，不泄露堆栈 | `internal_error` 无 detail；不回显异常/路径/SQL；request_id 与上下文一致 | 通过 |
| D | Mutation | 精确确认值 | 有写操作时缺少或错误确认不得执行 | 仅 ConnectedAccount catalog 无业务写工具；设计 §6；旧实现 `amazon_disconnect_connection` 另测 | 不适用（有设计依据） |
| D | Idempotency | 相同键相同/不同请求 | 写操作复用结果或 409 | 同上，仅 ConnectedAccount catalog | 不适用（有设计依据） |
| D | Concurrency | revision/ETag | 旧版本拒绝，重读合并后成功 | 同上，仅 ConnectedAccount catalog | 不适用（有设计依据） |
| D | Timeout | 上游结果未知 | 写操作标记 unknown，先查询 | 同上，仅 ConnectedAccount catalog | 不适用（有设计依据） |
| E | Token | 正常提前刷新 | 缓存、持久化与调度一致 | PostgreSQL 密文读取 + Redis TTL 缓存；生产真实 LWA exchange 通过 | 通过 |
| E | Token | 明确失效错误 | 强制刷新并只重试一次 | M2-T1：`Unauthorized` 401/403 单次 recover；二次失效停止；`test/sp-api-client.test.ts` | 通过 |
| E | Token | 并发与多实例 | 单次有效刷新，无 Refresh Token 丢失 | 两 provider 共享 Redis lock，生产真实并发仅 1 次 LWA exchange | 通过 |
| E | Token | 普通 5xx/权限错误 | 不错误触发刷新 | M2-T1：403 InvalidInput/404/429/5xx recover=0 | 通过 |
| E | Secret | 数据库与配置 | 长期凭据加密，测试 Token 只存摘要 | PostgreSQL 保存 AES-GCM JSON envelope；迁移前后 1 条密文一致且无明文列 | 通过 |
| E | Secret | API/MCP/前端 | 无 Token、Secret、内部 tenant | ConnectedAccount/旧实现 output Schema、HTTP 投影和生产响应扫描通过 | 通过 |
| E | Log | 成功/失败/鉴权/协议 | request ID、结果、耗时和安全摘要齐全 | M4：事件字典白名单；`mcp.*.`/`lwa.*`/`sp_api.*` | 通过 |
| E | Log | 敏感参数 | Token、query、revision、幂等键不出现 | logger 丢弃未知字段；测试 canary | 通过 |
| E | Network | URL（只读脚本） | 协议/userinfo/query/fragment/redirect/timeout/1MiB | `scripts/test_verify_connected-account_account_mcp.py` 覆盖 | 通过 |
| E | Network | 文件/Webhook 输入 | 产品不接受 | 工具 input Schema 无 URL/file/webhook；设计规格 §9 | 不适用（有设计依据） |
| E | Queue | Worker 重试 | 有上限、退避、dead-letter/unknown | 当前无异步 Queue/Worker；设计禁止虚构指标 | 不适用（有设计依据） |
| E | Deploy | HTTPS/反向代理 | MCP 与回调使用正确 public origin | `8947ff0` 已部署；systemd/Nginx/内外 health 通过；ConnectedAccount 路由仍由 flag 关闭；生产端到端 HTTPS 对 M5 仍阻断 | 部分 |
| E | Rotate | JWT key | 双信任切换并等待旧 JWT 过期 | verifier 多 kid + `docs/operations/jwt-key-rotation-runbook.md`；生产 330s 窗演练仍需运维签字 | 通过 |
| E | Rotate | 凭据加密 key | 旧密文可解密并渐进重加密 | M2-T2/T3：v2 envelope+AAD、legacy 双读、`rotate-encryption-key.mjs` dry-run/apply、RT CAS | 通过 |
| E | Observability | 指标与告警 | 覆盖授权、Token、MCP、上游；Queue 不适用 | `/internal/metrics` loopback-only；`docs/operations/alerts-runbook.md`；Queue 不适用 | 通过 |
| E | Script | 只读验收脚本 | 公开与带 JWT 检查全部通过 | 脚本已固定入库（SHA-256 见 `scripts/SOURCE.md`）；单元测试覆盖非法 URL/redirect/超限/JSON；生产 canary 历史 4/4 | 通过 |

## 阻断上线条件

以下任一项失败时，`CONNECTED_ACCOUNT_ENABLED` 必须保持 `false`：

- 可通过输入 tenant、user、employee 或 account 绕过当前 Employee 范围。
- JWT 签名、kid、issuer、audience、时间或 Scope 校验不完整。
- Token、Secret、授权 code/state 或敏感业务内容出现在输出、页面或日志。
- 授权 state 可复用、可跨 Employee 消费，或归属由浏览器参数决定。
- Disconnect/Unbind 会误删其他有效绑定或底层凭据。
- MCP 错误进入成功 output Schema，导致真实错误丢失。
- 多实例 Token 刷新、Attempt 完成或回调消费没有锁与数据库唯一约束。

## 证据记录格式

每次 example 验收更新表格的“当前证据”和“状态”，并记录：部署 commit、测试命令结果摘要、HTTP 状态与安全字段摘要、验收日期。不得粘贴生产凭据或完整响应日志。

## 2026-07-21 Phase A 部署记录

- 部署提交：`2a56846`；兼容迁移设计提交：`a4daa9b`。
- example：`npm test` 76/76、`npm run typecheck`、`npm run build` 全部通过。
- 只读验收：临时回环实例的 discovery 与 `/mcp/healthz` 通过 skill 脚本；临时 Employee JWT 的 `auth/check` 返回 200。
- 生产：`/healthz`、`/mcp/healthz` 返回 16 个工具，`/readyz` 的 Token Store、OAuth 回环和加密密钥均为 `ok`；公网 health 返回 200。
- 安全开关：生产未配置 `CONNECTED_ACCOUNT_ENABLED=true`，discovery 返回 404；旧实现路径继续运行，OAuth 服务未重启。
- 未完成：`/connected-account/v1/accounts` 和完整生命周期 API、ConnectedAccount Binding 数据、业务工具 `account_id` 迁移，因此带 JWT 的完整 skill 脚本尚未通过，不能开启生产 feature flag。

## 2026-07-21 Phase B 受控验收记录

- OAuth 桥提交：`2356753`；账号生命周期提交：`7bdd09e`。
- example 临时目录：OAuth 11/11、MCP 82/82、typecheck、build、systemd unit verify 全部通过。
- skill 只读验收：临时编译产物的 discovery、MCP health、Employee JWT、空账号列表四项全部通过。
- 覆盖：两个 issuer 相同 sub、同 issuer 两个 Employee、一个 Employee 两账号、Attempt TTL/归属、重复绑定、备注、refresh、解绑、断开、回调重放与安全 Origin/响应头。
- 兼容性：旧实现 `oat_*`、旧 `sellingPartnerId`、独立 OAuth 服务与生产默认关闭的 `CONNECTED_ACCOUNT_ENABLED` 均保留。
- 上线门槛：当前 SQLite 仅用于单实例受控验证；业务工具 `account_id` 归属改造、PostgreSQL/Redis、多实例锁与正式生产验收未完成，生产不得开启 ConnectedAccount feature flag。

## 2026-07-21 业务工具账号选择器预部署验收记录

- 实现提交：`f0154bd`。
- example 独立临时目录：`npm test` 84/84、`npm run typecheck`、`npm run build` 全部通过。
- ConnectedAccount：10 个业务工具的 Schema 只接受必填 `account_id`；服务端按已验证 `issuer + employee_id` 联合校验 active Binding、Grant 和 Account。
- 拒绝路径：跨 issuer、跨 Employee、解绑、断开、账号失效均不可解析；非所属账号不触发 SP-API。
- 兼容性：旧实现同一批业务工具仍只暴露可选 `sellingPartnerId`，单连接自动选择和多连接不猜测行为保持不变。
- 上线门槛不变：PostgreSQL/Redis、多实例锁与正式生产验收仍未完成，`CONNECTED_ACCOUNT_ENABLED` 必须保持 `false`。

## 2026-07-22 M0 规格冻结记录

- 设计规格对齐 11 章模板；冻结 `independentOwnerAuthorization=false`（与 `oauth_connection.selling_partner_id` 全局排他及跨 tenant 冲突一致）。
- 删除语义区分 Unbind / ConnectedAccount Disconnect / 旧实现 Disconnect / Credential Revoke / Physical Delete。
- 明确写工具确认值/幂等/revision 对 ConnectedAccount catalog 不适用；key version 未实现为上线阻断。
- 只读脚本固定入库：`scripts/verify_connected-account_account_mcp.py`，SHA-256 `cbc6236f52982cf657ebf5ce3a41e71020718499bb9e7fe59a9ed78c674db7c2`。
- 证据目录：`docs/acceptance/`；协议冻结测试：`test/connected-account-protocol-freeze.test.ts`。
- 安全开关不变：`CONNECTED_ACCOUNT_ENABLED=false`。

## 2026-07-22 Phase E 生产存储与多实例验收记录

- 实现提交：`e99e734`、`63a1661`、`1545b7c`、`d51f09a`、`8947ff0`；生产 release 为 `8947ff0`。
- example release 目录：MCP 88/88、OAuth 13/13、typecheck、build、systemd unit verify 全部通过。
- PostgreSQL：迁移 1 条加密连接，tenant/密文完整；ConnectedAccount schema version 为 1，共 7 张表。
- Redis：OAuth intent 跨实例单次消费；LWA 两实例真实并发仅 1 次 exchange；key 不含原始合成标识。
- 四实例 canary：OAuth A/B health 通过，MCP A/B readiness 6/6，Attempt 跨实例可见，skill 各 4/4。
- 生产：OAuth/MCP active，内部 readiness、公网 health、Nginx 和日志脱敏检查通过；原 JSON 哈希未变化。
- 回滚：`/var/backups/amazon-sp-api/20260722T005337Z/pre-8947ff0` 的文件与数据库备份已通过 SHA-256 校验。
- 安全开关：真实 ConnectedAccount issuer/key/origin、key 版本化轮换和 M4 尚未完成，生产继续 `CONNECTED_ACCOUNT_ENABLED=false`。
