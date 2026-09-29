# Amazon SP-API 生产应用审核包

> 生产应用审核材料草稿，当前架构更新日期：2026-07-28。本文可进入 Git，但不得写入 Application ID、LWA Client Secret、Refresh Token、ConnectedAccount JWT、真实卖家 ID、个人联系方式或录屏账号密码。

## 1. 提交状态

| 材料 | 状态 | 提交前动作 |
| --- | --- | --- |
| 产品说明与权限用途 | 已起草 | 用最终品牌、法定主体复核英文文本 |
| 架构与数据流 | 已起草并与代码对账 | 部署后复核域名、服务边界 |
| OAuth 端到端录屏脚本 | 已起草 | 完成 M6 Amazon Sandbox 后录制并保存到私有运营目录 |
| 隐私政策 URL | 阻塞 | 发布公开页面并填入 `[PRIVACY_POLICY_URL]` |
| 服务条款 URL | 阻塞 | 发布公开页面并填入 `[TERMS_URL]` |
| 数据删除说明 URL | 阻塞 | 发布公开页面并填入 `[DATA_DELETION_URL]` |
| 安全联系人 | 阻塞 | 填入受监控的 `[SECURITY_EMAIL]`，不要把真实地址提交到本文件 |
| 数据保留与外部共享方 | 阻塞 | 法务/运维确认期限及实际服务商后填写 Portal |
| 审核录屏 | 阻塞 | 按第 8 节录制，无密钥、Token、真实订单信息 |

**提交门：** 上述阻塞项全部关闭，沙盒 E2E 通过，并确认生产 MCP 只接受本服务本地验签的 ConnectedAccount Employee JWT 或数据库中 active Test Agent 的独立 `oat_*` Token，且两类凭据均通过统一账号策略后，才提交 Amazon 生产应用审核。

## 2. Portal 基础信息

| 字段 | 建议值 |
| --- | --- |
| Application name | `<你的应用名称>`（提交前确认最终英文品牌名） |
| API type | Selling Partner API |
| Organization type | Public solution provider |
| Supported entities | Sellers only |
| Authorization | Public OAuth, initiated by the selling partner |
| Requested roles | 只申请已启用 action 对应的非受限 Seller 角色；见 [能力与角色矩阵](../SP-API-READ-CAPABILITIES.md) |
| Restricted roles / RDT | None |
| OAuth Login URI | `https://api.example.com/oauth/amazon/login` |
| OAuth Redirect URI | `https://api.example.com/oauth/amazon/callback` |
| Organization website | `https://connectedAccount.me`（提交前确认与法定主体一致） |

Application ID、LWA Client ID 和 Secret 仅在 Solution Provider Portal 与受限生产配置中维护，不复制到审核文档或录屏字幕。

## 3. Product description

### English — ready to adapt

> ConnectedAccount Amazon Operations Assistant is a seller-authorized, read-only operations assistant for Amazon sellers. After a seller completes Amazon OAuth consent, an authenticated ConnectedAccount employee can use the seller's bound account to retrieve non-restricted operational data such as marketplace participation, catalog and listings information, non-PII orders, inventory, pricing, analytics, finances, fulfillment, warehousing, A+ Content, reports, Data Kiosk queries, feeds, and integration metadata. Every capability is selected from a versioned allowlist derived from Amazon's official API models.
>
> The application does not change prices, listings, fulfillment status, buyer messages, or any other Amazon business data. It does not request buyer or recipient PII and does not use Restricted Data Tokens. Every connection has an Employee owner and can be shared only to explicitly bound Employees in the same trusted issuer. Each call revalidates the server-side active Account, Grant, Binding, and Credential; clients cannot select a tenant, owner, seller ID, or credential. Disconnect deletes only the selected owner's encrypted refresh token and stops that Grant without affecting another owner's independent authorization; sellers can also revoke the application in Seller Central Manage Your Apps.

### 中文核对稿

ConnectedAccount Amazon 运营助手是由卖家主动授权的只读运营助手。授权后，已认证的 ConnectedAccount Employee 可以使用当前绑定账号查询 Marketplace、Catalog、Listings、非 PII 订单、库存、Pricing、Analytics、Finances、Fulfillment、Warehousing、A+ Content、Reports、Data Kiosk、Feeds 和集成元数据。应用不修改 Amazon 业务状态，不请求 Restricted Data Token，不请求买家或收件人 PII。

## 4. Role justification

### English — ready to adapt

> We request only the non-restricted Seller roles required by the read actions enabled in the submitted product. Each operation, API version, role, region, data classification, and inclusion reason is recorded in our versioned capability registry. Requested roles may include Product Listing, Inventory and Order Tracking, Pricing, Selling Partner Insights, Brand Analytics, Finance and Accounting, Amazon Fulfillment, Amazon Warehousing and Distribution, and operation-specific Reports, Feeds, and Notifications roles when the corresponding product capability is enabled and demonstrated.
>
> We do not request restricted roles, buyer or recipient information, tax data, payment identifiers, Amazon Ads data, Vendor APIs, the Tokens API, or Restricted Data Tokens. Operations that change business state are not exposed. Existing sellers are required to reauthorize after a new non-restricted role is added.

### 当前功能边界

- 已实现：冻结清单中 93 个 Seller 非受限只读 operation，Listings 固定注册；
- 开放原则：只启用已完成角色申请、重新授权和生产验证的 action；
- 明确不做：PII、改价、发货确认、消息、Listing 写入、Amazon Ads；
- 权限扩展原则：先同步官方模型、安全分类、实现和验证，再逐 operation 申请必要角色，不预申请。

## 5. Architecture and data flow

```text
Seller browser
  -> Amazon OAuth consent
  -> https://api.example.com/oauth/amazon/login + /callback
  -> amazon-sp-api-service (single process, port 8789)
  -> PostgreSQL AES-256-GCM encrypted refresh-token store

Authenticated ConnectedAccount employee
  -> https://api.example.com/mcp/amazon
  -> nginx/TLS
  -> amazon-sp-api-service (127.0.0.1:8789)
       -> local ConnectedAccount JWT verification
       -> Employee/account Binding + Grant ownership check
       -> shared Redis/in-memory LWA access-token cache
       -> Amazon SP-API
       -> official-model projection + operation-level PII removal
       -> MCP structured response
```

### Components and access

| Component | Stored/processed data | Access boundary |
| --- | --- | --- |
| Browser OAuth flow | One-time state, authorization code | Short-lived, single-use state; HTTPS public callback |
| 单一应用进程 | OAuth、ConnectedAccount、MCP、暂态 SP-API 响应 | 回环端口上游仅经 nginx/TLS 公开；无内部 OAuth HTTP API 和共享进程间 Secret |
| Token store | AES-256-GCM ciphertext、IV/tag、key ID、所有权元数据 | 受限服务账号、PostgreSQL 权限和 keyring；无明文 Refresh Token 落盘 |
| ConnectedAccount JWT verifier | issuer、audience、kid、Scope、时间声明 | 本地 `connectedAccount.jwtKeys` 验签；不请求外部身份服务 |
| 缓存 | 短期 LWA Access Token、连接/区域元数据 | Redis 与进程内存；连接断开或 TTL/重启时失效 |
| Structured logs | Event, timestamp, status, latency, request ID, hashed tenant/seller identifiers; complete `tools/call` arguments in a separate restricted JSONL | Complete arguments are retained for 168 hours and never written to ordinary stdout or PostgreSQL; ordinary logs contain no authorization header, auth code, refresh token, client secret, buyer or recipient data |

The MCP service does not persist SP-API business responses in its own database. It projects upstream responses through explicit allowlists before returning them. Any broader product-side retention outside this service must be separately documented before submission.

## 6. Security and privacy statement

### English — ready to adapt

> Access is Employee- and account-scoped. The bearer credential presented to the MCP endpoint is a ConnectedAccount Employee JWT that is verified locally against the configured key ring, issuer, audience, key ID, scope, signature, and time claims. Before an SP-API request is sent, the service verifies that the requested opaque account ID is actively bound to the authenticated employee through its account, grant, and binding records.
>
> LWA refresh tokens are encrypted at rest with AES-256-GCM. LWA client credentials and encryption keys are stored in restricted server environment files and are not committed to source control. Access tokens are cached only in process memory and are invalidated when a connection is removed.
>
> Requests and responses are validated against a frozen snapshot of Amazon's official API models. Buyer and recipient datasets are not requested, unknown upstream fields are discarded, and operation-specific PII fields and presigned URLs are removed. Ordinary logs contain operational metadata and keyed hashes of employee/account identifiers; they do not contain authorization headers, OAuth codes, JWTs, access tokens, refresh tokens, client secrets, document bodies, or raw buyer/recipient data. As an explicit diagnostic exception, complete `tools/call` arguments are written only to a restricted JSONL, retained for 168 hours, and never copied to ordinary stdout or PostgreSQL.

### 必须由组织补齐的政策事实

以下内容不能由代码推断，提交前必须由法务/运维确认并与公开政策一致：

- 除明确保留 168 小时的 `tools/call` 参数 JSONL 外，其他 SP-API 数据及运维日志的具体保留期限；
- 数据删除请求的接收渠道、处理时限和验证方式；
- 云主机、CDN、监控、日志、备份等外部共享方/子处理者；
- 安全事件通知时限、值班负责人和升级路径；
- 跨境传输、备份和灾难恢复安排（如适用）。

## 7. Disconnect, deletion, and renewal

### Current implemented behavior

1. 账号授权、绑定、解绑、断开和刷新只通过 `/connected-account/v1/*` Connected Account 协议管理，MCP 不提供连接写工具。
2. 解绑只停用当前 Employee Binding；断开只停用当前 Grant 及其 Binding，不误删其他 issuer/Employee 实体。
3. 凭据撤销停止对应 OAuth 连接并失效 LWA、连接和区域缓存。
4. 本地断开停止本服务使用凭据；卖家仍可在 Seller Central **Manage Your Apps** 完成 Amazon 端撤销。
5. 重新授权会创建新 `/connected-account/v1/authorization-attempts`，并要求卖家重新同意当前角色。

### English — ready to adapt

> Sellers can disconnect an Amazon account from the product through the connected-account workflow. The service verifies the authenticated employee's account binding and grant before changing connection state, and invalidates related cached credentials. Sellers can additionally revoke the application from Seller Central Manage Your Apps. Reauthorization requires a new seller consent flow. Data deletion requests will be handled through [DATA_DELETION_URL] and [PRIVACY_POLICY_URL] after those public procedures are approved and published.

Do not submit the last sentence with placeholders unresolved.

## 8. Review video script

Store the recording in a private operational location. Do not commit the video or reviewer credentials.

### Preflight

- Use a dedicated test seller with no sensitive production orders on screen.
- Close developer tools, terminals, password managers, environment files and browser autofill popups.
- Confirm no Token, Application ID, seller ID, email, address or payment detail is visible.
- Use a production-like build; shared Legacy Bearer authentication is not present.
- Prepare a valid short-lived ConnectedAccount Employee JWT outside the recording and ensure the UI masks it.
- Start with no connection, or clearly explain the existing test connection.

### Recording sequence (target: 5–8 minutes)

1. **Product and use case** — show the product name and explain that access is seller-authorized and read-only.
2. **Start authorization** — use the Admin console to select a Registry Employee and create an Owner-aware Authorization Attempt（或用该 Employee JWT 调 `/connected-account/v1/authorization-attempts`）；确认浏览器只打开同源 `/oauth/amazon/start` 后跳转 Amazon。
3. **Amazon consent** — show the Amazon-hosted sign-in/consent screen and the requested role; do not expose credentials.
4. **Callback success** — return to the completion page, complete the account binding, then call `amazon_list_accounts` to show the account belongs to the current Employee.
5. **Connection health** — call `amazon_connection_health` and explain that it refreshes the LWA access token and verifies the connection.
6. **Read-only data** — call `amazon_get_read_capabilities`, then demonstrate only operations whose roles are included in the submitted application; point out that buyer/recipient and unknown upstream fields are absent.
7. **Disconnect** — use the `/connected-account/v1/connections/{connectionId}` product workflow with explicit UI confirmation.
8. **Post-disconnect proof** — repeat a data call and show the stable not-connected failure without exposing raw credentials or upstream bodies.
9. **Reauthorization** — create a new authorization attempt and confirm the connection is restored if the review requires the complete renewal loop.
10. **Seller-side revocation** — state that the seller can also revoke the application in Seller Central Manage Your Apps; show it only if doing so will not expose unrelated applications.

### Recording evidence log

Record alongside the private video:

| Field | Value |
| --- | --- |
| Date/time and timezone | `[RECORDING_TIME]` |
| Build/commit | `[DEPLOYED_COMMIT]` |
| Application type | Sandbox / production draft beta |
| Test seller alias | Non-sensitive alias only |
| Steps passed | Authorization / binding / capabilities / selected read actions / disconnect / renewal |
| Reviewer video location | `[PRIVATE_VIDEO_LOCATION]` |
| Operator | `[OPERATOR]` |

## 9. Security contact and incident response draft

Portal contact: `[SECURITY_EMAIL]` — must be a monitored organizational mailbox with a named primary and backup owner in the private runbook.

Proposed response procedure:

1. Triage the report and identify affected tenant, seller connection, credential and time window.
2. Contain access: disable the affected connection or service path, invalidate access-token caches, rotate internal/LWA secrets when indicated.
3. Preserve credential-safe logs and Amazon request IDs; never copy tokens or PII into tickets or chat.
4. Determine whether SP-API data or credentials were accessed, altered, disclosed or unavailable.
5. Remediate, test tenant isolation and restore service only after the containment check passes.
6. Notify Amazon, affected sellers and authorities according to approved contractual/legal timelines.
7. Document root cause and preventive action in the private incident record.

Submission must use the organization's approved incident policy and real contact, not this draft alone.

## 10. Evidence matrix

| Claim | Repository evidence | Runtime/private evidence required |
| --- | --- | --- |
| Employee-bound identity | `src/identity.ts`, `src/connectedAccount.ts`, `src/http.ts` | ConnectedAccount JWT validation screenshot/log without token |
| Seller ownership check | `src/tools.ts`, `src/connected-account-accounts.ts`, ownership tests | Cross-Employee/account rejection test result |
| Encrypted refresh token | `src/token-store.ts`, `src/postgres-token-store.ts` | File permissions and ciphertext inspection, no value copied |
| Credential-safe logs | `src/logger.ts`, HTTP/LWA tests | Sanitized production log sample |
| Frozen operation coverage | `vendor/amazon-sp-api-models/operations.json`, `src/generated/sp-api-registry.ts` | Submitted commit and role set match deployed build |
| Non-PII output projection | `src/sp-api-operations.ts`, `src/safe-output.ts`, projection tests | Recorded response with no PII/unknown fields/presigned URL |
| Stateless document paging | `src/document-reader.ts`, document tests | Bounded page, expiry and cross-Employee rejection evidence |
| Disconnect and cache invalidation | `src/connection-service.ts`, `src/lwa.ts`, tests | Video steps 7–9 |
| Removed internal OAuth management API | `src/connection-service.ts`, `src/server.ts`, nginx/systemd config | `/internal/amazon/*` always returns 404; consumers call the in-process service |
| Read-only product scope | Tool annotations and `README.md` | Video shows no write action |

## 11. Final submission checklist

- [ ] Legal organization name and product brand are final and consistent.
- [ ] Organization website resolves over HTTPS and identifies the same entity.
- [ ] `[PRIVACY_POLICY_URL]`, `[TERMS_URL]`, `[DATA_DELETION_URL]` are public and reviewed.
- [ ] `[SECURITY_EMAIL]` is monitored and tested.
- [ ] Retention periods and external sharing/subprocessors are confirmed.
- [ ] OAuth Login URI and Redirect URI exactly match the deployed routes.
- [ ] M6 Sandbox authorization/callback/binding/disconnect/reauthorization passes for the selected Employee Owner.
- [ ] MCP accepts only locally verified ConnectedAccount Employee JWTs or active database-backed `oat_*` Test Agent tokens; unknown, disabled, rotated, revoked, and shared Bearer tokens return 401.
- [ ] Service startup and requests do not access `host.docker.internal:8080`; readiness contains no identity dependency.
- [ ] Requested roles match only implemented, demonstrated operations.
- [ ] Video follows section 8 and contains no credentials or PII.
- [ ] Evidence log identifies the deployed commit and test application type.
- [ ] Final package is reviewed by product, security/operations and the legal owner.

## 12. Official references

- [Register your SP-API application](https://developer-docs.amazon.com/sp-api/docs/registering-your-application)
- [Authorize SP-API applications](https://developer-docs.amazon.com/sp-api/docs/authorizing-selling-partner-api-applications)
- [SP-API roles](https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api)
- [Role mappings for operations](https://developer-docs.amazon.com/sp-api/docs/role-mappings)
- [Tokens API / RDT use cases](https://developer-docs.amazon.com/sp-api/docs/tokens-api-use-case-guide)
- [Seller read capabilities and role matrix](../SP-API-READ-CAPABILITIES.md)
