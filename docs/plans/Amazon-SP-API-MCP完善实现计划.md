# Amazon SP-API MCP 完善实现计划

> 文档版本：`2026-07-22`（PostgreSQL/Redis 与多实例生产验收更新）
>
> 适用范围：`amazon-sp-api-mcp/` 及配套 `amazon-oauth-service/`
>
> 关联文档：
>
> - `docs/operations/Amazon-SP-API管理.md` — 应用配置、OAuth、上线检查清单
> - `docs/business/Amazon-SP-API欧洲站点经营体检-2026-07-20.md` — 能力边界实测
> - `amazon-sp-api-mcp/README.md` — 工具与运行配置
>
> 安全边界：本文档不包含 Client Secret、Refresh Token、Access Token 或任何真实凭证。

---

## 0. 目标与非目标

### 0.1 目标

把当前已可内测联调的 Amazon SP-API MCP，演进为：

1. **多租户安全可依赖**：租户隔离无旁路、错误语义稳定、就绪探针可用。
2. **Agent 可稳定编排**：工具说明、快照工具、分页/区域体验足够好，减少误调用。
3. **经营诊断可落地**：在不放开写操作的前提下，补齐 Listings 等只读能力。
4. **可对外卖家开放**：完成沙盒 E2E、生产应用审核材料与运维门槛。

### 0.2 非目标（本计划明确不做）

| 不做 | 原因 |
| --- | --- |
| 买家/收件人 PII 读取 | 合规与角色原则；输出白名单必须持续拒绝 |
| 改价、发货确认、消息、Listing 写 | 未实现二次确认与审计；不应预申请角色 |
| Amazon Ads API 并入本 MCP | 独立认证与产品面，后续单独服务 |
| 微信公众号服务承载 Amazon 页面/路由 | 系统边界已确定，禁止回潮 |
| 为未实现功能提前申请 SP-API 角色 | 与 `docs/operations/Amazon-SP-API管理.md` 权限原则一致 |
| 重写为 monorepo / 换语言 / 换 MCP 传输 | 现有 Streamable HTTP + Express 已验证 |

### 0.3 成功判据（总验收）

全部满足后，本计划视为完成：

- [x] 生产路径仅接受旧实现 Agent Token（或显式受控的调试开关），无「无租户可读任意允许卖家」旁路。
- [x] 任意数据工具在调用前完成「当前租户拥有该 `sellingPartnerId`」校验。
- [ ] `npm test` / `npm run typecheck` / `npm run build` 在 CI 中稳定通过。工作流和 example 等价流程已通过；当前仓库无 Git remote，尚无 GitHub Actions 运行证据。
- [x] `/healthz` 与 `/readyz` 语义分离；部署可据此判活/判就绪。
- [x] Agent 无需猜测即可完成：列连接 → 健康检查 → 订单/库存查询 →（可选）经营快照。
- [x] 若启用 Listings：角色已申请且只读工具 + 投影白名单 + 测试齐全。
- [ ] 沙盒端到端（授权/调用/断开/再授权）与生产审核材料齐备，方可对外部客户开放。（M4，本次验收排除）

---

## 1. 现状基线（2026-07-21）

### 1.1 已落地

| 模块 | 路径 | 状态 |
| --- | --- | --- |
| Streamable HTTP MCP | `src/http.ts`, `src/server.ts` | 已部署 `127.0.0.1:8789`，公网 `/mcp/amazon` |
| 11 个工具 | `src/tools.ts` | 6 数据 + 1 健康 + 4 连接管理 |
| LWA + Token Store | `src/lwa.ts`, `src/token-store.ts` | AES-256-GCM；租户归属字段 |
| OAuth 内部客户端 | `src/oauth-client.ts` | 回环 intent/连接/断开 |
| 身份 | `src/identity.ts` | `oat_` → 旧实现校验；legacy Bearer |
| 限流 / 日志 / 投影 | `rate-limit.ts`, `logger.ts`, `safe-output.ts` | 租户 RPM、hash 日志、PII 剥离 |
| 单测 | `test/*.test.ts` | 模块覆盖齐全 |
| 生产 beta | 管理文档 §7–§9 | 真实 EU 卖家 Marketplace/订单/库存只读已验证 |

### 1.2 已知缺口（按影响排序）

| ID | 缺口 | 影响 |
| --- | --- | --- |
| G1 | legacy 无 `tenantId` 仍可走部分数据路径 | 多租户生产风险 |
| G2 | `AMAZON_ALLOWED_SELLING_PARTNER_IDS` 静态列表主导放行 | 规模化运维瓶颈；与租户连接模型不一致 |
| G3 | 调用前未统一「连接归属」校验（主要依赖 Token 文件 tenant 字段） | 错误信息不统一；Agent 难自愈 |
| G4 | Token 文件每次 `getRefreshToken` 全量读盘 | 性能与文件竞态 |
| G5 | LWA 同 key 并发可能双刷新 | 无谓 429 / 延迟 |
| G6 | 区域探测无缓存（na→eu→fe） | 多余 403 与延迟 |
| G7 | 限流 `Map` 不清理 | 长期内存增长 |
| G8 | `/healthz` 过浅 | 部署误判就绪 |
| G9 | 工具 description / 无 `instructions` | Agent 误用率高 |
| G10 | 无跨站点经营快照工具 | 体检类任务成本高 |
| G11 | 无 Listings / FBM 可见性 | 无法区分「没生意」与「范围不够」 |
| G12 | 错误对 Agent 非结构化 | 重试/引导困难 |
| G13 | 无 CI；本地需先 `npm install` | 回归成本 |
| G14 | 沙盒 OAuth URI 与完整沙盒 E2E 未勾完 | 审核与对外门槛 |
| G15 | 生产应用仍为草稿 | 不能正式对外部客户开放 |

### 1.3 架构示意（保持，计划内不推倒）

```text
Agent / Codex
  |  Bearer oat_*  (或临时 legacy)
  v
Nginx api.example.com
  |  /mcp/amazon  -> 127.0.0.1:8789
  |  /oauth/amazon/* -> 127.0.0.1:8788
  v
amazon-sp-api-mcp
  |-- identity  -> LEGACY loopback session
  |-- oauth-client -> OAuth internal (intent/connections)
  |-- token-store  -> /var/lib/amazon-oauth-service/tokens.json (AES-GCM)
  |-- lwa          -> api.amazon.com/auth/o2/token
  +-- sp-api       -> sellingpartnerapi-{na,eu,fe}.amazon.com

amazon-oauth-service (独立)
  授权 start/login/callback/renew + internal 连接管理
```

---

## 2. 阶段总览

| 阶段 | 名称 | 主题 | 预估工作量 | 依赖 |
| --- | --- | --- | --- | --- |
| **M1** | 硬化 | 鉴权、归属、缓存、就绪、CI、错误码 | 3–5 人日 | 无 |
| **M2** | Agent 体验 | instructions、description、snapshot、分页 | 2–3 人日 | M1 核心合并后 |
| **M3** | 诊断能力 | Listings 只读（+ 可选 FBM 可见性） | 4–6 人日 | M1；现有 Inventory and Order Tracking 角色 |
| **M4** | 对外开放 | 沙盒 E2E、审核材料、监控告警、legacy 下线 | 3–5 人日 + 审核等待 | M1+M2；M3 可选 |

建议节奏：

1. 先合 **M1** 并部署到现有服务器，验证目标租户回归。
2. 紧接着 **M2**（无 Amazon 角色变更，风险低）。
3. **M3** 与 **M4 审核材料** 可并行：Listings 只读代码、录屏与文档一边做，生产 beta 回归一边准备。
4. 外部客户流量仅在 **M4 总验收** 后打开。

---

## 3. M1 — 生产硬化

### 3.1 目标

消除租户旁路，统一连接归属校验，降低 Token/LWA/区域成本，补齐可观测与 CI。

### 3.2 任务拆分

#### M1-T1 生产鉴权策略

**文件：** `src/config.ts`, `src/identity.ts`, `src/http.ts`, `src/server.ts`, 对应测试

**行为变更：**

1. 新增配置 `MCP_ALLOW_LEGACY_AUTH`（默认 `false` 推荐；迁移期可 `true`）。
2. 当 `MCP_ALLOW_LEGACY_AUTH=false` 时：
   - 拒绝 legacy Bearer；
   - 仅接受 `oat_*` 且校验成功的 principal（必须有 `tenantId`）。
3. 当 `MCP_ALLOW_LEGACY_AUTH=true`（仅本机/应急）：
   - legacy 仍可用，但 **禁止** 在无 `tenantId` 时调用数据工具；
   - 或强制绑定 `MCP_LEGACY_TENANT_ID`（若设置）作为伪租户。
4. 数据工具与连接工具统一要求「有效 tenant」：`options.tenantId` 缺失时返回稳定错误码 `TENANT_REQUIRED`。

**验收：**

- [x] 无租户 token 调用任意工具 → HTTP 403，且在创建 MCP server / 调用 SP-API 前拒绝。
- [x] 默认配置下生产路径只有校验成功并携带 tenant 的 legacy 身份。
- [x] `test/config.test.ts` / `test/identity.test.ts` / `test/http.test.ts` 覆盖默认关闭、显式迁移开关和租户绑定。

**实施记录（2026-07-21）：**

- 新增 `MCP_ALLOW_LEGACY_AUTH`，严格解析 `true` / `false` 且默认 `false`；默认模式不再要求或接受 `MCP_AUTH_TOKEN`。
- legacy 仅在显式开启且 Token 至少 32 字节时可认证；可用 `MCP_LEGACY_TENANT_ID` 绑定限定迁移租户。
- MCP HTTP 入口统一拒绝缺少 tenant 的 principal，返回通用 403，拒绝发生在 MCP server 创建、限流和 SP-API 调用之前。
- 默认仅将 `oat_*` 交给 loopback 身份服务验证，并要求返回合法可信 tenant；身份网络、状态、JSON 或字段异常均 fail closed。
- README 与 `.env.example` 已补充生产默认值、迁移开关和回滚约束；完成前验证 58 项测试、类型检查、构建与 `git diff --check`。
- 独立审查 **91/100**（正确性 34、安全 24、测试 17、文档 7、可维护性 9），生产代码无阻断问题，达到 90 分完成线。
- 本地 Git 提交：本条实施记录与 M1-T1 代码、测试在同一原子提交中归档。

**回滚：** 同时设置 `MCP_ALLOW_LEGACY_AUTH=true`、至少 32 字节的 `MCP_AUTH_TOKEN` 与限定的 `MCP_LEGACY_TENANT_ID`，重启后可临时恢复兼容；窗口结束后立即关闭。

---

#### M1-T2 连接归属作为权威校验

**文件：** `src/tools.ts`, `src/oauth-client.ts`, 可选 `src/token-store.ts`

**行为变更：**

1. 抽取 `assertSellerAccess(tenantId, sellingPartnerId)`：
   - 调用 `connections.listConnections(tenantId)`（可加短 TTL 缓存，见 M1-T4）；
   - 不在连接列表中 → `NOT_CONNECTED` 或 `SELLER_FORBIDDEN`；
   - 多连接省略 `sellingPartnerId` → 保持现有 `sellingPartnerId is required when ... multiple connections`。
2. `AMAZON_ALLOWED_SELLING_PARTNER_IDS` 语义调整为 **平台级硬开关**（封禁/灰度）：
   - 仍拒绝不在列表中的卖家（若列表非空）；
   - 文档写明：日常租户绑定以 OAuth 连接为准，不再靠改环境变量加人。
3. 中期可选：支持 `AMAZON_ALLOWED_SELLING_PARTNER_IDS=*` 或空值表示「仅连接列表」（**仅在 M4 前评估安全影响后启用**）。

**验收：**

- [x] 租户 A 的 token 无法读租户 B 的 seller（即使 seller 在全局允许列表中且 Token 文件存在）。
- [x] 未连接卖家时错误文案引导：先 `amazon_create_authorization_url` / `amazon_list_connections`。
- [x] 单测 mock `AmazonConnectionManager` 覆盖 0/1/N 连接。

**实施记录（2026-07-21）：**

- `resolveSellingPartnerId` 在租户连接上下文中总是先读取当前租户连接；显式传入的 seller 也必须存在于该列表。
- 越权或未连接 seller 返回稳定 `NOT_CONNECTED`，并引导使用授权 URL 或连接列表工具；拒绝发生在 SP-API 调用之前。
- 保留无 `connections` 注入时显式 seller 的兼容路径；生产租户路径由 OAuth 连接列表作为权威归属来源。
- 新增 tenant A / seller B 拒绝测试，并保留 0/1/N 连接选择覆盖；完成前验证 45 项测试、类型检查、构建与 `git diff --check`。
- 独立审查评分 **91/100**（正确性 33、安全 24、测试 17、文档 8、可维护性 9），无阻断问题，达到 90 分完成线。
- 本地 Git 提交：本条实施记录与 M1-T2 代码、测试在同一原子提交中归档。

**注意：** 当前每次数据工具调用会查询 OAuth 连接列表；短 TTL 缓存与主动失效在 M1-T4 实现。

---

#### M1-T3 稳定错误码

**文件：** 新建 `src/errors.ts`；改 `tools.ts`, `sp-api-client.ts`, `lwa.ts`, `oauth-client.ts`, `token-store.ts`

**错误模型（建议）：**

```ts
export type AmazonMcpErrorCode =
  | "TENANT_REQUIRED"
  | "NOT_CONNECTED"
  | "SELLER_REQUIRED"
  | "SELLER_FORBIDDEN"
  | "SELLER_NOT_ALLOWED"      // 平台允许列表
  | "AUTH_EXPIRED"           // LWA/refresh 失败
  | "IDENTITY_REJECTED"
  | "REGION_MISMATCH"
  | "INVALID_FILTER"
  | "RATE_LIMITED"
  | "UPSTREAM_SP_API"
  | "UPSTREAM_OAUTH"
  | "UPSTREAM_LWA"
  | "INTERNAL";

export class AmazonMcpError extends Error {
  constructor(
    readonly code: AmazonMcpErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
  }
}
```

**工具层输出约定：**

- MCP `isError: true` 时，`text` 为 JSON：
  `{ "code", "message", "retryable", "details?" }`
- 禁止把 Amazon 原始 body、refresh token、authorization header 写入 message。

**映射表：**

| 来源 | code |
| --- | --- |
| 无 tenant | `TENANT_REQUIRED` |
| 无连接 / 404 disconnect | `NOT_CONNECTED` |
| 多连接未指定 seller | `SELLER_REQUIRED` |
| Token store tenant 不匹配 | `SELLER_FORBIDDEN` |
| 不在允许列表 | `SELLER_NOT_ALLOWED` |
| LWA `invalid_grant` | `AUTH_EXPIRED`（引导 renewal）；其他 4xx 为 `UPSTREAM_LWA` |
| SP-API 429 | `RATE_LIMITED` + retryable |
| SP-API 5xx / 网络 | `UPSTREAM_SP_API` + retryable |
| marketplace 跨区 | `REGION_MISMATCH` / `INVALID_FILTER` |
| search_orders 时间窗 | `INVALID_FILTER` |

**验收：**

- [x] 单测断言关键路径返回 code 而非纯字符串包含匹配。
- [x] 日志 `errorType` 优先记 code。

**实施记录（2026-07-21）：**

- 新增 `src/errors.ts`，统一输出 `{ code, message, retryable, details? }`，并过滤未知及嵌套 details。
- 在 `McpServer` 工具错误出口建立归一化边界：SDK/Zod 预校验错误映射为 `INVALID_FILTER`，未知异常安全映射为 `INTERNAL`。
- 租户、连接、Token Store、OAuth、LWA 与 SP-API 的已知状态、网络和非法 JSON 响应均映射到稳定错误码。
- OAuth 404/409 按具体操作映射；LWA 仅将 `invalid_grant` 识别为 `AUTH_EXPIRED`，避免把 `invalid_client` 误报为卖家授权过期。
- SP-API 与 LWA 网络失败日志使用稳定 `errorType`，不记录原始异常信息或凭证。
- 通过 TDD 补充 schema/业务参数错误、未知异常、连接选择、跨区、429、非法 JSON、网络失败、Token Store 和归属测试。
- 完成前验证：`npm test`（44 项通过）、`npm run typecheck`、`npm run build`、`git diff --check`。
- 独立审查经过整改复审后评分 **93/100**（正确性 33、安全 24、测试 18、文档 9、可维护性 9），无阻断问题，达到 90 分完成线。
- 本地 Git 提交：本条实施记录与 M1-T3 代码、测试在同一原子提交中归档。

---

#### M1-T4 缓存：连接列表、区域、Token 文件、LWA in-flight

| 缓存 | 键 | TTL / 失效 | 实现位置 |
| --- | --- | --- | --- |
| 连接列表 | `tenantId` | 30–60s；disconnect / create auth 成功后主动失效 | 新建 `src/connection-cache.ts` 或并入 oauth-client 包装 |
| 卖家区域 | `tenantId + sellingPartnerId` | 24h；disconnect 失效；403 全区域失败时失效 | `tools.ts` 旁 |
| Token 文件 | 全局 | 按 `mtime` + size；mtime 变则重读 | `token-store.ts` |
| LWA in-flight | `tenantId + sellingPartnerId` | Promise 共用至 resolve/reject | `lwa.ts` |

**LWA 伪代码：**

```ts
// 同 key 若已有 inFlight，await 同一 Promise，避免双刷新
```

**验收：**

- [x] 并发 10 次同 seller `getAccessToken` 仅 1 次打 LWA（单测 fake fetch 计数）。
- [x] Token 文件 mtime 与 size 不变时复用解析缓存，元数据变化后重读。
- [x] disconnect 后连接列表、区域与 access token 缓存均失效。

**实施记录（2026-07-21）：**

- LWA Access Token 以 `tenantId + sellingPartnerId` 为键进行 single-flight；共享失败后可重试，严格 force refresh 与 invalidate 使用 generation 防止旧 in-flight 回填。
- OAuth 连接列表按 tenant 缓存 30 秒并合并并发请求；disconnect 成功后失效，失败不失效，generation 防止断开前的旧列表覆盖新缓存。
- Token Store 按文件 `mtimeMs + size` 复用已解析内容，文件变化后重新读取，读取或解析失败不写入缓存。
- Amazon 区域按 `tenantId + sellingPartnerId` 缓存 24 小时；普通探测、健康探测失败及 disconnect 都会精确失效。
- README 已记录缓存 TTL、隔离、失败和进程重启语义；完成前验证 56 项测试、类型检查、构建与 `git diff --check`。
- 首次独立审查 78/100；修复 force refresh 竞态与普通区域失败失效并补充并发测试后，复审 **95/100**（正确性 34、安全 24、测试 19、文档 9、可维护性 9），无阻断问题。
- 本地 Git 提交：本条实施记录与 M1-T4 代码、测试在同一原子提交中归档。

---

#### M1-T5 限流状态清理

**文件：** `src/rate-limit.ts`

**行为：**

- `acquire` 时若 principal 窗口过期且 `active===0`，可删除条目；或每 N 次 acquire 扫一遍。
- 单测：模拟时钟前进后 Map size 回落。

**验收：**

- [x] 过期且无活跃请求的 principal 状态会被清理。
- [x] 活跃请求不会被清理，释放操作保持幂等。
- [x] 模拟时钟专项测试 3/3 通过。

**实施记录（2026-07-21）：**

- 限流器在固定窗口轮转时删除过期且 `active===0` 的 principal，并通过周期扫描清理长期不再访问的键。
- 保留活跃 principal，避免并发请求仍在处理时丢失计数；release 继续保持幂等。
- 独立审查 **93/100**（正确性 34、安全 24、测试 18、文档 8、可维护性 9），无阻断问题，达到 90 分完成线。
- 本地 Git 提交：`7db2494 fix(amazon-mcp): clean stale rate limit state`。

---

#### M1-T6 健康检查拆分

**文件：** `src/http.ts`, `src/server.ts`, 部署 nginx 片段

| 路径 | 语义 | 检查内容 |
| --- | --- | --- |
| `GET /healthz` | liveness | 进程响应；返回 `status: ok`, `tools`, `version` |
| `GET /readyz` | readiness | Token 文件可读；可选 HEAD/GET OAuth `/healthz`（若有）loopback；加密 key 可解析；**不**调用 Amazon 公网 |

**响应示例：**

```json
{
  "status": "ready",
  "checks": {
    "tokenStore": "ok",
    "oauthInternal": "ok",
    "encryptionKey": "ok"
  }
}
```

任一关键检查失败 → HTTP 503 + `status: "not_ready"`。

**部署：**

- Nginx：`/healthz/amazon-mcp` 继续指 liveness 或改为 readyz（二选一写进管理文档）。
- systemd：不强制 `ExecStartPost` 调 readyz，但运维手册要求部署后 curl。

**验收：**

- [x] 故意指错 `AMAZON_TOKEN_STORE_FILE` → `/healthz` 200，`/readyz` 503。
- [x] 测试覆盖 Token 文件、加密密钥、OAuth HTTP/JSON/LWA 配置及异常脱敏。

**实施记录（2026-07-21）：**

- `/healthz` 保持纯 liveness；`/readyz` 并行检查 Token 文件可读、加密密钥可解析和 OAuth 回环健康状态，任一失败返回 HTTP 503。
- OAuth 检查设置 3 秒超时，并要求成功 JSON 严格满足 `status=ok` 与 `lwaConfigured=true`；网络、非 2xx、非法 JSON 或未配置 LWA 均 fail closed。
- readiness 响应只返回固定检查类别，不暴露 Token 路径、内部凭证或底层异常，也不调用 Amazon 公网。
- README 与管理文档明确公网 `/healthz/amazon-mcp` 仅判活、内部 `127.0.0.1:8789/readyz` 用于部署判就绪且不经 Nginx 暴露。
- 初次独立审查 72/100；完成三个阻断项整改并补充异常测试后，复审 **93/100**（正确性 35、安全 24、测试 17、文档 10、可维护性 7），无阻断问题，达到 90 分完成线。
- 基础提交：`b030182 feat(amazon-mcp): add readiness endpoint`；整改与计划归档在后续本地提交记录。

---

#### M1-T7 CI 与工程卫生

**仓库内：**

1. 新增 `.github/workflows/amazon-sp-api-mcp-ci.yml`（或 monorepo 等价路径）：
   - Node 22
   - `npm ci`
   - `npm test`
   - `npm run typecheck`
   - `npm run build`
2. `sp-api-client.ts`：将文件末尾 `import` 移至顶部。
3. README 补充：克隆后必须 `npm install`；生产关闭 legacy 的推荐 env。
4. `.env.example` 增加 M1 新变量并注释默认值。

**验收：**

- [x] CI 使用 Node.js 22、`npm ci`、测试、类型检查和构建，并从仓库根目录定位 MCP 工作目录。
- [x] workflow YAML、锁文件安装与本地等价命令已独立审查。

**实施记录（2026-07-21）：**

- 新增 `.github/workflows/amazon-sp-api-mcp-ci.yml`，对 push 与 pull request 使用 Node.js 22 和 npm 缓存。
- CI 在 `amazon-sp-api-mcp/` 依次执行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`。
- 独立审查 **91/100**（正确性 33、安全 23、测试 18、文档 8、可维护性 9），无阻断问题，达到 90 分完成线。
- 本地 Git 提交：`ba1df18 ci(amazon-mcp): add Node 22 checks`。

---

### 3.3 M1 交付物

| 交付物 | 说明 |
| --- | --- |
| PR-M1a | 鉴权 + 错误码 + 归属校验 |
| PR-M1b | 缓存 + 限流清理 + import 整理 |
| PR-M1c | healthz/readyz + CI + 文档 |
| 部署说明 | 环境变量 diff；回滚目录约定 |
| 回归脚本 | 对目标租户：list_connections → health → list_marketplaces → search_orders（可空） |

### 3.4 M1 验收清单

- [x] 所有单测通过；typecheck/build 通过。
- [x] 服务器部署后 `/readyz` 200。
- [x] 目标旧实现用户 Agent Token 全工具回归。
- [x] legacy 在默认配置下被拒绝（或仅绑定调试租户）。
- [x] 日志无 token/PII；错误含 code。
- [x] 更新 `docs/operations/Amazon-SP-API管理.md` §9 实现状态。

### 3.5 M1 整体回归与综合审查（2026-07-21）

- 使用 CI 等价流程执行 `npm ci`，随后 `npm test`（59/59）、`npm run typecheck`、`npm run build` 与 `git diff --check`，全部通过。
- 静态检查确认 Node.js 22 workflow 包含 `npm ci`、测试、类型检查和构建；源码日志/错误出口未发现凭证字段直出。
- 首次综合独立审查 **87/100**，指出错误 JSON 可透传 primitive secret/PII、Token/LWA/SP-API tenant 契约可选、无连接上下文兼容旁路及文档漂移。
- 整改后公共错误 message 按 code 固定，details 仅允许 `status`、`requestId`、`retryAfterSeconds`；凭证、LWA、SP-API 和工具 seller 解析边界均强制 tenant 与连接归属 fail closed。
- `.env.example` 补充租户限流默认值，README 与管理文档统一生产 beta、legacy 和 readiness 运维口径。
- 同一独立审查 Agent 复审 **94/100**（正确性 33、安全 24、测试 19、文档 9、可维护性 9），无阻断问题，达到 90 分完成线。
- 生产上线验收已于 2026-07-21 对 `1b40c54` 完成：example `/readyz` 200，Token Store、OAuth 回环与加密密钥检查均为 `ok`；目标 Agent Token 覆盖 14 个工具。
- 断开工具仅使用错误确认值验证 `INVALID_FILTER` 保护，未删除真实授权；需求真实断开/再授权的流程归 M4。

---

## 4. M2 — Agent 体验

### 4.1 目标

在不增加 Amazon 角色、不扩大写面的前提下，降低 Agent 误用与多站体检成本。

### 4.2 任务拆分

#### M2-T1 Server `instructions`

**文件：** `src/tools.ts`

在 `McpServer` 构造时增加简短 instructions（中英择一，建议中文主、关键参数英文名保留），内容必须覆盖：

1. 先 `amazon_list_connections`；无连接则 `amazon_create_authorization_url`。
2. 多连接必须传 `sellingPartnerId`。
3. `amazon_search_orders`：`createdAfter` 与 `lastUpdatedAfter` 二选一；时间须带 offset 的 ISO-8601。
4. 多 marketplace 必须同区域（na/eu/fe）。
5. 不提供买家、地址、支付、追踪号等 PII；不要反复索要。
6. 断连必须 `confirmDisconnect=DISCONNECT`。
7. 授权 URL 仅浏览器打开，10 分钟一次性。

**验收：** Client `listTools` / initialize 可见 instructions（按 SDK 能力验证）。

---

#### M2-T2 工具 description 操作手册化

逐工具补充：

| 工具 | 必须写清 |
| --- | --- |
| `amazon_search_orders` | 时间窗互斥；建议窗口；`paginationToken` 来自上一页 |
| `amazon_list_inventory_summaries` | 仅 FBA；FBM 为空属正常 |
| `amazon_list_marketplaces` | 可省略 region；返回 `region` 供后续调用 |
| `amazon_connection_health` | 强制刷新 token；应用作排障第一步 |
| `amazon_create_renewal_url` | 与首次授权区别；避免 MD1000 |
| `amazon_disconnect_connection` | 仅删本地凭证；Amazon 侧需卖家自行禁用 |

**验收：** 单测可对 description 做关键子串断言（可选，避免过脆）。

---

#### M2-T3 `amazon_business_snapshot`（组合工具）

**类型：** 只读编排，**不**新增 SP-API 角色。

**输入：**

```ts
{
  sellingPartnerId?: string;
  marketplaceIds?: string[];      // 默认：参与中的全部（注意区域拆分）
  lookbackDays?: number;          // 默认 30，最大 90
  includeInventory?: boolean;     // 默认 true
  includeListings?: boolean;      // 默认 false；需 M3 flag 开启
  maxMarketplaces?: number;       // 默认 11，防止刷爆
}
```

**步骤：**

1. 解析 seller + 归属校验。
2. `discoverMarketplaceRegion`（走缓存）。
3. 拉 marketplace participations；过滤 `isParticipating`。
4. 按区域分组；每组一次 `search_orders`（`createdAfter`/`createdBefore`，`maxResultsPerPage=1` 或统计策略见下）。
5. 可选：每站或抽样站 `list inventory summaries`（控制并发 ≤ 租户限流安全值）。
6. 输出结构化摘要 + 数据边界声明。

**订单计数策略（务实）：**

- 首版：**不保证精确总数**（Orders API 分页成本高）。
- 返回：`ordersSampled`, `hasOrders`, `firstPageCount`, `paginationHint`。
- 文档写明：精确总数需后续专用工具或异步任务。

**输出投影：** 仅聚合字段 + 非 PII；附 `dataBoundary` 字符串（复用体检报告口径）。

**限流：** 内部调用计入同一租户 limiter；snapshot 本身可标记更高 cost（可选独立并发槽）。

**验收：**

- [x] 对当前 EU 11 站空数据账号返回「连接正常、订单/库存为空、边界说明」，与体检报告一致方向。
- [x] 单测用 mock SpApiReader 固定响应。

---

#### M2-T4 分页与返回形态

1. 所有分页工具在 JSON 中统一：
   - `pagination.nextToken`（已有则保持）
   - 可选 `pagination.hasMore: boolean`
2. 可选参数 `autoPage?: boolean`（默认 false；true 时最多翻 N 页，N≤5，防止 Agent 打爆）。
3. 考虑 MCP `structuredContent`（若 SDK 版本支持）与 text JSON 双写；至少保持 text JSON 兼容。

**验收：** autoPage 上限单测；默认行为与现网兼容。

---

#### M2-T5 自然语言短摘要（可选，建议做）

在 `jsonResult` 旁增加可选 `summary` 字段（1–3 句），例如：

- 「EU 区域，11 个参与站点，近 30 天首屏订单 0，FBA 汇总 0。」

规则：

- 摘要只基于投影后字段生成；
- 不得编造趋势；
- 空数据明确说「无数据」而非「下降 0%」。

---

### 4.3 M2 交付物

| 交付物 | 说明 |
| --- | --- |
| PR-M2a | instructions + description |
| PR-M2b | business_snapshot + 分页增强 |
| README 工具表更新 | 默认 12 个；开启 Listings 后 14 个 |
| healthz `tools` 计数 | 与真实注册数一致；生产当前为 14 |

### 4.4 M2 验收清单

- [x] 新 Agent 会话仅凭 instructions 能完成授权引导与一次订单查询（SDK initialize + 生产人工走查）。
- [x] snapshot 不触发未授权角色接口。
- [x] 工具数量与 nginx/health 文档同步。

**生产验证记录（2026-07-21）：**

- SDK initialize 返回的 instructions 覆盖连接引导、多卖家选择、订单时间互斥、区域、PII、断开确认和 10 分钟一次性授权。
- 真实 Agent Token 走通 `list_connections → connection_health → list_marketplaces → search_orders → list_inventory_summaries → business_snapshot`。
- 账号识别 EU 11 个参与站点；抽样 1 站时订单、FBA 库存和 Listings 均为 0，快照包含数据边界。
- 生产 `/healthz` 与公网健康端点均报告 14 个工具，内部 `/readyz` 200，公网 `/readyz` 404。

---

## 5. M3 — 诊断能力（Listings 只读）

### 5.1 目标

支持回答：「有没有在售 Listing？是否 FBM？是否全站暂停？」——对齐欧洲体检报告建议第 4 条。

### 5.2 前置条件（非代码）

| 项 | 动作 | 负责人 |
| --- | --- | --- |
| 角色 | 官方映射确认两个只读 operation 均可使用现有 **Inventory and Order Tracking**；无需新增 Product Listing | — |
| 原则 | 保持最小权限；未来增加新 operation 时再逐项核对角色，不预申请受限角色 | — |
| 演示 | 准备 Listings 只读演示路径，供 App Review | — |

M3 代码仍先合 **feature flag** `AMAZON_ENABLE_LISTINGS_TOOLS=false`，完成静态沙盒与生产 beta 回归后再打开。

### 5.3 任务拆分

#### M3-T1 API 选型与路径确认

调研并文档化（写入本计划附录或管理文档）：

- 使用的 Listings Items API 版本与 path；
- 所需 RDT：**默认不申请受限 PII**；确认 listings 读是否触发 RDT；
- 沙盒是否可测。

**产出：** [`../connected-account/listings-items-integration.md`](../connected-account/listings-items-integration.md)（endpoint、配额、角色/RDT、沙盒、错误码、字段白名单）。

**调研结论（2026-07-21）：** `getListingsItem` 与 `searchListingsItems` 使用 v2021-08-01；现有 Inventory and Order Tracking 角色已覆盖；二者不是受限 PII operation，不需要 RDT。

---

#### M3-T2 新工具设计

| 工具名 | 用途 | 只读 |
| --- | --- | --- |
| `amazon_search_listings` | 按 marketplace + 可选 SKU/状态查询 Listing 摘要 | 是 |
| `amazon_get_listing_item` | 单 SKU Listing 详情（非 PII 字段） | 是 |

**输入要点：**

- `sellingPartnerId?`, `marketplaceId`, `sellerSku?`, `pageSize`, `pageToken`
- 状态过滤若 API 支持：`BUYABLE` / `DISCOVERABLE` 等

**禁止字段（投影黑名单/白名单）：**

- 任何买家信息、供应商私密备注若含敏感则剔除；
- 仅保留：ASIN、SKU、标题、状态、履约渠道、可售数量（若有）、上架问题摘要码（非原文堆砌）。

**实现位置：**

- `sp-api-client.ts`：`operationForPath` 增加 listings 操作名；
- `safe-output.ts`：`projectListingsResponse`；
- `tools.ts`：注册工具 + flag。

---

#### M3-T3 与 snapshot 集成

扩展 `amazon_business_snapshot`：

- `includeListings?: boolean`（默认 false，直到 flag 打开且角色可用）；
- 输出 `listingCountsByMarketplace` 或 `sampleListingCount`；
- `dataBoundary` 更新：声明已含/不含 Listings。

---

#### M3-T4 测试与合规

- [x] 单测：投影剥离敏感字段，并覆盖 Listings 400/413/415、403/404 的安全稳定错误映射。
- [x] 集成：生产 beta 自有卖家对参与 Marketplace 完成 `searchListingsItems` 真实 HTTP 200 空样本验证；因账号无 Listing，真实 get 与分页保留为数据条件验证。
- [x] 更新 `docs/operations/Amazon-SP-API管理.md` 角色表与 §9。
- [x] 欧洲体检类报告模板增加 Listings 抽样列、分页状态和数据边界。

### 5.4 M3 非本期（记入 backlog）

- FBA 入库货件、退货、财务事件、账号绩效（洞察销售伙伴）
- 受控调价、广告
- 异步报告（Reports API）大批量导出

### 5.5 M3 验收清单

- [x] flag 关闭时工具不可见；开启后可见且 annotations 只读。
- [x] 无角色/无资源时统一使用 `UPSTREAM_SP_API`，并以安全 `details.status` 区分 403 与 404；无效请求为 `INVALID_FILTER`。
- [x] 管理文档明确现有“库存和订单追踪”已覆盖 Listings 两个只读 operation，无需新增角色。

### 5.6 M1–M3 完成度验证（2026-07-21）

| 阶段 | 任务/验收完成度 | 生产证据 | 仍缺证据 |
| --- | --- | --- | --- |
| M1 | 7/7 任务，6/6 阶段验收项 | `readyz` 200；14 工具 Agent Token 回归；legacy 401；日志无凭证/PII | 仓库无 remote，GitHub Actions 实际运行记录尚无 |
| M2 | 5/5 任务，3/3 阶段验收项 | instructions、描述、分页与快照单测；EU 11 站真实空数据快照 | 无阻断项 |
| M3 | 4/4 任务，3/3 阶段验收项 | feature flag 开启；Listings 搜索与快照真实 HTTP 200；白名单投影与错误映射测试通过 | 账号无 Listing/SKU，真实 get 与有续页数据仍受数据条件限制 |

**结论：** M1–M3 的 16/16 个实现任务和各阶段验收清单已完成，生产版本为 `1b40c54`。example 干净 release 已通过 `npm ci`、71/71 测试、typecheck 和 build。排除 M4 后，剩余两项是外部 CI 运行证据与真实 Listing 数据条件，不是已知代码阻断。

---

## 6. M4 — 对外开放

### 6.1 目标

满足「外部 Amazon 卖家 OAuth 公共 SaaS」的合规与运维门槛；完成管理文档 §7 剩余项。

### 6.2 任务拆分

#### M4-T1 沙盒端到端

对照 `docs/operations/Amazon-SP-API管理.md` §7：

- [ ] 沙盒应用填写 OAuth Login URI + Redirect URI
- [ ] 沙盒授权 → MCP list_connections → 只读调用 → disconnect → 再授权
- [ ] 无效 state / 重放 state → 400
- [ ] 跨租户绑定冲突 → 409 语义正确

**产出：** 内部 E2E 记录（日期、Application ID 类型、结果），无密钥。

---

#### M4-T2 生产应用审核包

无密钥草稿存 Git；真实联系人、审核录屏、审核账号及 Portal 导出存私有运营目录：

- [x] 产品说明与权限用途（库存和订单追踪；Listings 尚未对外启用）
- [ ] 隐私政策、服务条款、数据删除说明 URL（组织网站）
- [ ] 端到端录屏：Agent 发起授权 → 卖家浏览器同意 → 查询订单/库存 → 断开
- [x] 架构说明：数据存哪、谁可访问、日志脱敏
- [x] 安全联系人与事件响应模板（真实联系人待组织填写）

**产出：** [`../connected-account/production-app-review-package.md`](../connected-account/production-app-review-package.md)。提交前仍须补齐公开政策 URL、数据保留/外部共享事实、安全联系人和私有录屏。

---

#### M4-T3 监控与告警

基于现有结构化日志字段：

| 信号 | 条件 | 动作 |
| --- | --- | --- |
| `mcp_auth_rejected` 突增 | 5m 内 > 阈值 | 告警（攻击或配置错误） |
| `lwa_token_exchange_completed` status!=200 | 连续失败 | 告警；引导 renewal |
| `sp_api_request_completed` 429 | 占比升高 | 降并发/查限流 |
| `mcp_request_limited` | 租户被限流 | 产品侧提示 |
| `/readyz` 503 | 持续 | 值班 |

实现可选：

- 短期：journald + 简单脚本 / Cloudflare 日志
- 中期：推送 Loki/Prometheus（本计划不强制）

---

#### M4-T4 配置与容量策略

1. 评估取消「每卖家必须写入环境允许列表」：
   - 方案 A：允许列表改为可选；空 = 仅连接归属
   - 方案 B：OAuth 回调成功时自动 append 受控文件（需文件锁与权限）
2. 租户默认限流复核：`120/min`、`8` 并发是否适合 snapshot + listings。
3. Token 文件备份与权限：`0600`、专用用户、异地备份策略（运维手册）。

---

#### M4-T5 legacy 下线

- [ ] 所有内部 Codex/自动化改用 `oat_*`
- [ ] `MCP_ALLOW_LEGACY_AUTH` 默认 false 且生产 env 不开启
- [ ] README 删除「共享 Token 可读数据」表述或标为 deprecated
- [ ] 发布说明：破坏性变更窗口

---

#### M4-T6 对外开关

在产品层（旧实现）控制：

- 哪些用户可见 Amazon MCP；
- 新卖家授权是否开放；
- 与 Amazon 生产应用「已批准」状态绑定的发布 checklist。

### 6.3 M4 验收清单

- [ ] 管理文档 §7 剩余 checkbox 全部勾完或标注「不适用+原因」。
- [ ] 生产应用状态变为可服务外部卖家（以 Amazon 控制台为准）。
- [ ] 无 legacy 依赖。
- [ ] 至少一次外部测试卖家（非公司自有）完整授权闭环（若政策允许；否则用第二测试账号）。

---

## 7. PR / 提交切片建议

按依赖排序，便于 review 与回滚：

| 顺序 | 切片 | 阶段 | 风险 |
| --- | --- | --- | --- |
| 1 | `errors` + 工具错误映射（行为兼容） | M1 | 低 |
| 2 | 连接归属校验 + 测试 | M1 | 中（行为变严） |
| 3 | legacy 开关默认 false（可先默认 true 部署再切） | M1 | 中高 |
| 4 | LWA in-flight + token mtime 缓存 + region 缓存 | M1 | 低 |
| 5 | rate-limit 清理 + sp-api import 整理 | M1 | 低 |
| 6 | readyz + CI + env.example | M1 | 低 |
| 7 | instructions + descriptions | M2 | 低 |
| 8 | business_snapshot | M2 | 中（配额） |
| 9 | 分页 autoPage | M2 | 低 |
| 10 | listings flag + tools + projection | M3 | 中（角色） |
| 11 | snapshot 集成 listings | M3 | 低 |
| 12 | 文档/审核/监控/legacy 下线 | M4 | 流程 |

**建议 Git 信息风格：** Conventional Commits，例如：

- `feat(mcp): require tenant for data tools`
- `fix(mcp): cache LWA in-flight refresh`
- `feat(mcp): add business snapshot tool`
- `docs: amazon mcp implementation plan progress`

---

## 8. 测试策略

### 8.1 单元测试（必保）

| 区域 | 重点 case |
| --- | --- |
| identity | legacy on/off；非法 oat；超时 |
| tools | 归属 0/1/N；错误码；snapshot mock |
| lwa | 缓存命中；in-flight 合并；forceRefresh |
| token-store | tenant 不匹配；mtime 缓存；坏 JSON |
| rate-limit | 并发；RPM；清理 |
| safe-output | buyer/recipient 永不出现 |
| http | 401/429/readyz 503 |

### 8.2 手工/服务器回归（每阶段部署后）

```text
1. curl /healthz /readyz
2. Agent Token: amazon_list_connections
3. amazon_connection_health
4. amazon_list_marketplaces
5. amazon_search_orders（合法时间窗）
6. amazon_list_inventory_summaries（单站）
7. （M2+）amazon_business_snapshot
8. （M3+）amazon_search_listings
9. amazon_disconnect_connection（测试卖家）+ 再授权
```

### 8.3 安全回归

- [x] 日志抽样无 refresh_token / client_secret / authorization 凭证；唯一 `authorization` 命中为工具名 `amazon_create_authorization_url`
- [x] 跨租户 seller ID 探测失败（单测覆盖，未在生产构造第二租户攻击）
- [x] 断连后旧 access cache 不可用（generation fence 与精确失效单测覆盖；本次未真实断开卖家）
- [x] OAuth internal 公网 404

---

## 9. 配置变更清单

| 变量 | 阶段 | 默认建议 | 说明 |
| --- | --- | --- | --- |
| `MCP_ALLOW_LEGACY_AUTH` | M1 | `false` | 生产关闭 legacy |
| `MCP_LEGACY_TENANT_ID` | M1 | 空 | 仅 legacy 调试时绑定 |
| 连接列表 TTL | M1 | 代码默认 `30000` ms | 当前未暴露环境变量；可在测试/构造时注入 |
| 区域缓存 TTL | M1 | 代码默认 `86400000` ms | 当前未暴露环境变量；可在测试/构造时注入 |
| `AMAZON_ENABLE_LISTINGS_TOOLS` | M3 | `false` | Listings 工具开关 |
| 现有变量 | — | 保持 | 见 `.env.example` 与 README |

部署顺序建议：

1. 先部署兼容代码（legacy 仍 true）。
2. 回归通过后改 env 关闭 legacy。
3. 再部署 M2/M3 功能开关。

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 归属校验导致现网唯一卖家调用失败 | 可用性 | 先用 legacy token 回归；确认 Token `tenantId` 与 session `user_id` 一致 |
| 连接 list 热路径打爆 OAuth | 延迟/429 | TTL 缓存；disconnect 主动失效 |
| snapshot 放大 SP-API 调用 | 429 | maxMarketplaces、并发上限、默认关 inventory 细查 |
| Listings 静态沙盒与真实数据存在差异 | 生产行为漏测 | feature flag；生产 beta 验证角色、分页和投影后再开放 |
| 关闭 legacy 打断本机 Codex | 开发体验 | 文档改 oat；或本机 env 显式打开 legacy+tenant |
| Token 文件读写竞态 | 偶发解密失败 | mtime 缓存；OAuth 写文件用原子 rename（oauth 侧检查） |

---

## 11. 回滚策略

| 场景 | 动作 |
| --- | --- |
| 新版本 MCP 进程异常 | systemd 回滚到 `/opt/amazon-sp-api-mcp.backup-*` |
| 仅配置问题 | 恢复 `/etc/amazon-sp-api-mcp.env` 上一版 |
| 归属校验过严 | 临时 feature flag `MCP_SKIP_CONNECTION_OWNERSHIP_CHECK` **仅应急且打 error 日志**（若引入，M4 前必须删除） |
| Listings 异常 | `AMAZON_ENABLE_LISTINGS_TOOLS=false` 重启 |

原则：**应急 flag 不得进入长期生产默认。**

---

## 12. 文档同步义务

每阶段合并后必须更新：

| 文档 | 更新内容 |
| --- | --- |
| `amazon-sp-api-mcp/README.md` | 工具表、env、安全边界 |
| `docs/operations/Amazon-SP-API管理.md` | §7 清单、§9 实现状态、角色 |
| 本计划 | 下方「进度跟踪」打勾与日期 |
| 欧洲体检模板 | 新数据列（M3） |

禁止在文档中粘贴密钥、完整卖家 Refresh Token、Agent Token。

---

## 13. 进度跟踪

### M1 硬化

- [x] M1-T1 生产鉴权策略（2026-07-21；独立审查 91/100；已归档至本地 Git）
- [x] M1-T2 连接归属校验（2026-07-21；独立审查 91/100；已归档至本地 Git）
- [x] M1-T3 稳定错误码（2026-07-21；独立审查 93/100；已归档至本地 Git）
- [x] M1-T4 缓存（连接/区域/Token/LWA）（2026-07-21；独立复审 95/100；已归档至本地 Git）
- [x] M1-T5 限流清理（2026-07-21；独立审查 93/100；专项测试 3/3 通过；提交 `7db2494`）
- [x] M1-T6 healthz/readyz（2026-07-21；初审 72/100，整改复审 93/100；基础提交 `b030182`）
- [x] M1-T7 CI 与工程卫生（2026-07-21；独立审查 91/100；提交 `ba1df18`）
- [x] M1 本地全量回归与综合审查（2026-07-21；初审 87/100，整改复审 94/100；59/59 tests、typecheck、build、diff-check 通过）
- [x] M1 服务器部署后 `/readyz` 与目标 Agent Token 真实回归（2026-07-21；生产 `1b40c54`；14 工具全覆盖）
- [x] PostgreSQL/Redis、多实例锁与正式生产技术验收（2026-07-22；生产 `8947ff0`；MCP 88/88、OAuth 13/13；四实例 canary 与真实 LWA 单次 exchange 通过）
- [x] 更新日期：2026-07-21  责任人：Pi Agent

### M2 Agent 体验

- [x] M2-T1 instructions（2026-07-21；initialize 可见并覆盖 7 条调用规则；独立审查 **93/100**）
- [x] M2-T2 description（2026-07-21；6 个关键工具说明操作手册化并有语义断言；独立审查 **95/100**）
- [x] M2-T3 business_snapshot（2026-07-21；初审 79/100；整改后合并 na/eu/fe 参与站点、逐次计入租户 limiter，并覆盖 EU 11 站空态与跨区 mock；独立复审 **92/100**）
- [x] M2-T4 分页（2026-07-21；初审 88/100；整改后默认单页兼容、autoPage 最多 5 页、统一 nextToken/hasMore，并阻止重复/循环 token；独立复审 **93/100**）
- [x] M2 本地全量回归与评分归档（2026-07-21；63/63 tests、typecheck、build、diff-check 通过；T1–T4 均达到 90 分完成线）
- [x] M2-T5 短摘要（2026-07-21；固定模板仅基于安全聚合字段生成，明确抽样边界，并指引订单/库存后续工具；独立审查 **92/100**，无阻断问题）
- [x] M2 部署与人工走查（2026-07-21；instructions 可见；EU 11 站订单/库存空态快照通过）
- [x] 更新日期：2026-07-21  责任人：Pi Agent

### M3 Listings

- [x] M3-T1 API 选型说明（2026-07-21；`docs/connected-account/listings-items-integration.md`）
- [x] 角色申请不适用（官方映射确认现有 Inventory and Order Tracking 已覆盖只读操作）
- [x] M3-T2 工具 + 投影 + flag（2026-07-21；新增 `amazon_search_listings` / `amazon_get_listing_item`，默认关闭；单站点路由、SKU 编码、非 PII 白名单投影与 feature flag 测试已落地；独立审查 **91/100**，无阻断问题）
- [x] M3-T3 snapshot 集成（2026-07-21；`includeListings` 默认关闭且受 Listings flag 约束；开启后每个已选 Marketplace 只抽样首批 20 个 Listing，输出可购买/问题样本、分页提示与明确数据边界，不返回 SKU 或原始 Listing 字段；初审 **89/100**，整改本地 20 条硬上限、摘要语义与 limiter 覆盖后复审 **98/100**；69/69 tests、typecheck、build、diff-check 通过）
- [x] M3-T4 测试与合规（2026-07-21；投影与 Listings 状态错误测试齐全；生产 beta `searchListingsItems` 和 M3-T3 snapshot Listings 均完成真实 HTTP 200 空样本验证；管理文档、角色表和欧洲体检模板已更新；71/71 tests、typecheck、build、diff-check 通过；独立审查 **96/100**，无阻断问题。真实 get/有续页分页仍受账号无 Listing/SKU 的数据条件限制）
- [x] 更新日期：2026-07-21  责任人：Pi Agent

### M4 对外

- [ ] M4-T1 沙盒 E2E
- [ ] M4-T2 审核包（无密钥草稿完成；待政策 URL、安全联系人、保留/共享事实和录屏）
- [ ] M4-T3 监控告警
- [ ] M4-T4 允许列表策略
- [ ] M4-T5 legacy 下线
- [ ] M4-T6 产品开关
- [ ] 总验收
- [ ] 更新日期：2026-07-21  责任人：Pi Agent

---

## 14. 建议执行顺序（给实施者）

```text
Week 1:  M1-T3 → M1-T2 → M1-T1（先兼容默认）→ M1-T4 → M1-T5 → M1-T6 → M1-T7
         部署兼容版 → 回归 → 关闭 legacy
Week 2:  M2-T1/T2 → M2-T3 → M2-T4 → 部署
         并行：M4-T1 沙盒 URI、M4-T2 材料起草、M3 静态沙盒 fixture
Week 3+: M3 实现（flag）→ 生产 beta 回归后打开
         M4 监控与 legacy 下线 → 审核提交 → 通过后产品放量
```

---

## 15. 附录

### 15.1 当前工具清单（基线 11）

| 工具 | 类型 |
| --- | --- |
| `amazon_list_marketplaces` | 只读数据 |
| `amazon_search_orders` | 只读数据 |
| `amazon_get_order` | 只读数据 |
| `amazon_list_order_items` | 只读数据 |
| `amazon_list_inventory_summaries` | 只读数据 |
| `amazon_get_inventory_by_sku` | 只读数据 |
| `amazon_connection_health` | 只读健康 |
| `amazon_create_authorization_url` | 连接管理 |
| `amazon_create_renewal_url` | 连接管理 |
| `amazon_list_connections` | 连接管理 |
| `amazon_disconnect_connection` | 破坏性连接管理 |

### 15.2 计划新增工具

| 工具 | 阶段 |
| --- | --- |
| `amazon_business_snapshot` | M2 |
| `amazon_search_listings` | M3 |
| `amazon_get_listing_item` | M3 |

### 15.3 关键代码索引

| 主题 | 文件 |
| --- | --- |
| 入口装配 | `amazon-sp-api-mcp/src/server.ts` |
| HTTP/MCP | `amazon-sp-api-mcp/src/http.ts` |
| 工具注册 | `amazon-sp-api-mcp/src/tools.ts` |
| 身份 | `amazon-sp-api-mcp/src/identity.ts` |
| 配置 | `amazon-sp-api-mcp/src/config.ts` |
| LWA | `amazon-sp-api-mcp/src/lwa.ts` |
| Token | `amazon-sp-api-mcp/src/token-store.ts` |
| SP-API | `amazon-sp-api-mcp/src/sp-api-client.ts` |
| 投影 | `amazon-sp-api-mcp/src/safe-output.ts` |
| OAuth 客户端 | `amazon-sp-api-mcp/src/oauth-client.ts` |
| OAuth 服务 | `amazon-oauth-service/server.mjs` |
| systemd | `amazon-sp-api-mcp/amazon-sp-api-mcp.service` |

### 15.4 Docker/YAML 可移植部署（M4 之外）

- [x] 将 `amazon-oauth-service` 与 `amazon-sp-api-mcp` 构建为单镜像、单容器内两个受监督 Node.js 子进程。
- [x] OAuth 健康后再启动 MCP；任一子进程异常退出会终止另一个并使容器失败。
- [x] 私有 `config.yaml` 只读挂载且不进入 Git/镜像；严格校验未知字段、URL、密钥、权限、Seller allowlist 与固定容器端口。
- [x] Token Store 通过宿主机 `./data` 持久化；容器 UID/GID `10001`，启动时收紧目录/文件权限。
- [x] Compose 默认仅发布宿主机回环端口，并启用只读根文件系统、capability 全移除、`no-new-privileges` 与 tmpfs。
- [x] 部署文档覆盖首次安装、反向代理边界、迁移、备份、恢复、升级、回滚和身份服务网络风险。
- [x] 验证：Docker 配置测试 6/6、OAuth 9/9、MCP 72/72、typecheck、build、`docker compose config`、镜像构建和 OAuth/MCP/容器健康 smoke test 均通过。
- [x] 独立审查：初审 **82/100**；两轮整改 Linux 权限、私有配置校验、固定端口及 bridge 风险说明后终审 **94/100**，无 release blocker。
- [x] 2026-07-22 镜像运行时修复：OAuth 新增 PostgreSQL/Redis 后，使用独立 production dependency stage 安装其锁定依赖，并将 `redis-store.mjs` 打包进最终镜像；新增 `npm run test:docker-image -- <image>` 导入回归检查。
- [x] 2026-07-22 修复验证：镜像内 OAuth/MCP/配置模块导入通过；Docker 配置 6/6、OAuth 11/13（2 项需外部 PostgreSQL/Redis，跳过）、MCP 86/88（2 项需外部 PostgreSQL/Redis，跳过）、typecheck、build、Compose config 均通过；临时身份健康 stub 下容器达到 `healthy`，OAuth `/healthz`、MCP `/healthz` 与 `/readyz` 均返回 200。
- [x] 完成日期：2026-07-21。M4 继续按用户要求暂缓。

### 15.5 PostgreSQL/Redis 生产验收（M4 之外）

- [x] OAuth connection、ConnectedAccount Attempt/Grant/Binding/Account 迁移到独立 PostgreSQL database/schema。
- [x] OAuth state/intent、LWA Access Token cache 与刷新锁使用隔离 Redis namespace。
- [x] PostgreSQL schema DDL 使用事务级 advisory lock，Attempt/Binding 使用事务和唯一约束。
- [x] 四实例 canary、skill 只读脚本、跨实例 intent/Attempt、生产真实 LWA 并发与日志脱敏均通过。
- [x] 生产部署 `8947ff0`，回滚包与 SHA-256 清单已验证；详见 `docs/acceptance/production-storage-acceptance-2026-07-22.md`。
- [ ] `CONNECTED_ACCOUNT_ENABLED=true`：等待真实 issuer/key/origin、凭据 key 版本化轮换及 M4 人工/合规项，不属于本次技术验收通过范围。

### 15.6 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-07-22 | 修复 Docker 最终镜像遗漏 OAuth PostgreSQL/Redis 依赖及 `redis-store.mjs`；加入镜像导入回归检查并完成真实容器健康验证 |
| 2026-07-22 | 完成 PostgreSQL/Redis、多实例锁、四实例 canary 和生产技术验收，部署 `8947ff0`；ConnectedAccount 对外开关继续关闭 |
| 2026-07-21 | 完成 OAuth + MCP 单容器 Docker/YAML 可移植部署，完整验证通过；独立终审 94/100，无 release blocker；M4 仍暂缓 |
| 2026-07-21 | M1-T1 完成默认关闭 legacy 的生产鉴权策略，独立审查 91/100，无生产代码阻断问题 |
| 2026-07-21 | M1-T4 首审 78/100，整改两个阻断问题后复审 95/100，进入本地提交阶段 |
| 2026-07-21 | M1-T2 完成独立审查 91/100，无阻断问题，进入本地提交阶段 |
| 2026-07-21 | 完成 M1-T2 连接归属权威校验、测试与验证，进入独立审查 |
| 2026-07-21 | M1-T3 完成整改复审，独立审查 93/100，无阻断问题，进入本地提交阶段 |
| 2026-07-21 | 完成 M1-T3 稳定错误码实现、测试与验证，进入独立审查 |
| 2026-07-21 | 初版：M1–M4 详细实现计划 |
