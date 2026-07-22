# Amazon SP-API 生产应用审核包

> M4-T2 提交材料草稿，更新日期：2026-07-21。本文可进入 Git，但不得写入 Application ID、LWA Client Secret、Refresh Token、Agent Token、真实卖家 ID、个人联系方式或录屏账号密码。

## 1. 提交状态

| 材料 | 状态 | 提交前动作 |
| --- | --- | --- |
| 产品说明与权限用途 | 已起草 | 用最终品牌、法定主体复核英文文本 |
| 架构与数据流 | 已起草并与代码对账 | 部署后复核域名、服务边界 |
| OAuth 端到端录屏脚本 | 已起草 | 完成 M4-T1 后录制并保存到私有运营目录 |
| 隐私政策 URL | 阻塞 | 发布公开页面并填入 `[PRIVACY_POLICY_URL]` |
| 服务条款 URL | 阻塞 | 发布公开页面并填入 `[TERMS_URL]` |
| 数据删除说明 URL | 阻塞 | 发布公开页面并填入 `[DATA_DELETION_URL]` |
| 安全联系人 | 阻塞 | 填入受监控的 `[SECURITY_EMAIL]`，不要把真实地址提交到本文件 |
| 数据保留与外部共享方 | 阻塞 | 法务/运维确认期限及实际服务商后填写 Portal |
| 审核录屏 | 阻塞 | 按第 8 节录制，无密钥、Token、真实订单信息 |

**提交门：** 上述阻塞项全部关闭，M4-T1 沙盒 E2E 通过，生产环境关闭 legacy 鉴权后，才提交 Amazon 生产应用审核。

## 2. Portal 基础信息

| 字段 | 建议值 |
| --- | --- |
| Application name | `<你的应用名称>`（提交前确认最终英文品牌名） |
| API type | Selling Partner API |
| Organization type | Public solution provider |
| Supported entities | Sellers only |
| Authorization | Public OAuth, initiated by the selling partner |
| Requested role | Inventory and Order Tracking |
| Restricted roles / RDT | None |
| OAuth Login URI | `https://api.example.com/oauth/amazon/login` |
| OAuth Redirect URI | `https://api.example.com/oauth/amazon/callback` |
| Organization website | `https://connected-account.me`（提交前确认与法定主体一致） |

Application ID、LWA Client ID 和 Secret 仅在 Solution Provider Portal 与受限生产配置中维护，不复制到审核文档或录屏字幕。

## 3. Product description

### English — ready to adapt

> Legacy AI E-commerce Operations Assistant is a seller-authorized, read-only operations assistant for Amazon sellers. After a seller completes Amazon OAuth consent, the assistant can verify the connection, list the seller's participating marketplaces, retrieve non-PII order and order-item information, and inspect FBA inventory summaries. It helps the seller answer operational questions such as whether a marketplace connection is healthy, whether recent orders exist, and whether FBA inventory is available.
>
> The application does not change prices, listings, fulfillment status, buyer messages, or any other Amazon business data. It does not request buyer or recipient PII and does not use Restricted Data Tokens. Every connection is bound to the authenticated application tenant. A tenant can access only seller accounts that it authorized. Sellers can disconnect locally in the product, which deletes the stored encrypted refresh token and stops further API access; they can also revoke the application in Seller Central Manage Your Apps.

### 中文核对稿

<你的应用名称>是由卖家主动授权的只读运营助手。授权后可检查连接、查看参与站点、查询非 PII 订单与商品明细、查看 FBA 库存汇总。应用不改价、不改 Listing、不确认发货、不发送买家消息，也不请求买家或收件人 PII。每个卖家连接绑定到已认证租户，租户只能访问自己授权的卖家账号。

## 4. Role justification

### English — ready to adapt

> We request the Inventory and Order Tracking role only. The application uses this role to retrieve marketplace participation, non-PII order and order-item data, and FBA inventory summaries for the seller's own operational analysis. These capabilities are directly initiated by or presented to the authorizing seller.
>
> We do not request restricted roles, buyer information, recipient information, tax data, payment data, or Amazon Ads data. We do not use the Tokens API or Restricted Data Tokens. Listings Items read operations may be added only after feature-flagged implementation and production validation; Amazon's operation role mapping permits the existing Inventory and Order Tracking role for the planned read operations, so no additional role is requested for that scope.

### 当前功能边界

- 已启用：Marketplace、非 PII Orders、Order Items、FBA Inventory、连接健康检查；
- 尚未对外启用：Listings Items 工具；
- 明确不做：PII、改价、发货确认、消息、Listing 写入、Amazon Ads；
- 权限扩展原则：先实现并验证，再逐 operation 申请必要角色，不预申请。

## 5. Architecture and data flow

```text
Seller browser
  -> Amazon OAuth consent
  -> https://api.example.com/oauth/amazon/login + /callback
  -> OAuth service (loopback-only internal management API)
  -> AES-256-GCM encrypted refresh-token store

Authenticated agent
  -> https://api.example.com/mcp/amazon
  -> nginx/TLS
  -> Amazon MCP (127.0.0.1:8789)
       -> Agent Token validation -> trusted tenant ID
       -> tenant/seller ownership check
       -> in-memory LWA access-token cache
       -> Amazon SP-API
       -> explicit non-PII response projection
       -> agent response
```

### Components and access

| Component | Stored/processed data | Access boundary |
| --- | --- | --- |
| Browser OAuth flow | One-time state, authorization code | Short-lived, single-use state; HTTPS public callback |
| OAuth service | Tenant ID, selling partner ID, encrypted refresh token | Internal management routes require a shared secret and are not public |
| Token store | AES-256-GCM ciphertext, IV/tag, tenant ownership metadata | Restricted service account and file permissions; no plaintext token at rest |
| MCP service | Tenant ID, seller ID, transient SP-API response | Loopback process behind nginx; authenticated MCP requests only |
| In-memory caches | Short-lived LWA access token, connection/region metadata | Process memory; invalidated on disconnect or restart/expiry |
| Structured logs | Event, timestamp, status, latency, request ID, hashed tenant/seller identifiers | No authorization header, auth code, refresh token, client secret, buyer or recipient data |

The MCP service does not persist SP-API business responses in its own database. It projects upstream responses through explicit allowlists before returning them. Any broader product-side retention outside this service must be separately documented before submission.

## 6. Security and privacy statement

### English — ready to adapt

> Access is tenant-scoped. The bearer credential presented to the MCP endpoint is validated by the application identity service, and only the trusted tenant identifier from that validation is used. Before an SP-API request is sent, the service verifies that the requested selling partner connection belongs to that tenant.
>
> LWA refresh tokens are encrypted at rest with AES-256-GCM. LWA client credentials and encryption keys are stored in restricted server environment files and are not committed to source control. Access tokens are cached only in process memory and are invalidated when a connection is removed.
>
> SP-API responses are filtered through explicit field allowlists. Buyer and recipient datasets are not requested, and unknown upstream fields are discarded. Logs contain operational metadata and keyed hashes of tenant/seller identifiers; they do not contain authorization headers, OAuth codes, access tokens, refresh tokens, client secrets, or raw buyer/recipient data.

### 必须由组织补齐的政策事实

以下内容不能由代码推断，提交前必须由法务/运维确认并与公开政策一致：

- SP-API 数据及运维日志的具体保留期限；
- 数据删除请求的接收渠道、处理时限和验证方式；
- 云主机、CDN、监控、日志、备份等外部共享方/子处理者；
- 安全事件通知时限、值班负责人和升级路径；
- 跨境传输、备份和灾难恢复安排（如适用）。

## 7. Disconnect, deletion, and renewal

### Current implemented behavior

1. `amazon_disconnect_connection` requires explicit confirmation.
2. The OAuth service verifies tenant ownership and deletes that tenant's encrypted refresh-token record.
3. MCP connection, region, and LWA access-token caches are invalidated.
4. Subsequent calls fail until the seller authorizes again.
5. Local disconnect stops this service from using the credential; complete Amazon-side revocation remains available to the seller in Seller Central **Manage Your Apps**.
6. `amazon_create_renewal_url` provides the seller's reauthorization/renewal entry point.

### English — ready to adapt

> Sellers can disconnect an Amazon account from the product. The disconnect operation verifies tenant ownership, deletes the encrypted refresh token, invalidates related in-memory credentials and caches, and stops further SP-API access. Sellers can additionally revoke the application from Seller Central Manage Your Apps. Reauthorization requires a new seller consent flow. Data deletion requests will be handled through [DATA_DELETION_URL] and [PRIVACY_POLICY_URL] after those public procedures are approved and published.

Do not submit the last sentence with placeholders unresolved.

## 8. Review video script

Store the recording in a private operational location. Do not commit the video or reviewer credentials.

### Preflight

- Use a dedicated test seller with no sensitive production orders on screen.
- Close developer tools, terminals, password managers, environment files and browser autofill popups.
- Confirm no Token, Application ID, seller ID, email, address or payment detail is visible.
- Use a production-like build with legacy authentication disabled.
- Prepare a valid Agent Token outside the recording and ensure the UI masks it.
- Start with no connection, or clearly explain the existing test connection.

### Recording sequence (target: 5–8 minutes)

1. **Product and use case** — show the product name and explain that access is seller-authorized and read-only.
2. **Start authorization** — invoke the product action backed by `amazon_create_authorization_url`.
3. **Amazon consent** — show the Amazon-hosted sign-in/consent screen and the requested role; do not expose credentials.
4. **Callback success** — return to the completion page, then call `amazon_list_connections` to show the connection belongs to the current tenant.
5. **Connection health** — call `amazon_connection_health` and explain that it refreshes the LWA access token and verifies the connection.
6. **Read-only data** — call `amazon_list_marketplaces`, one bounded `amazon_search_orders`, and `amazon_list_inventory_summaries`; point out that buyer/recipient fields are absent. Empty test data is acceptable if connection and API success are visible.
7. **Disconnect** — invoke `amazon_disconnect_connection` with explicit confirmation.
8. **Post-disconnect proof** — repeat a data call and show the stable not-connected failure without exposing raw credentials or upstream bodies.
9. **Reauthorization** — show `amazon_create_renewal_url` or repeat authorization, then confirm the connection is restored if the review requires the complete renewal loop.
10. **Seller-side revocation** — state that the seller can also revoke the application in Seller Central Manage Your Apps; show it only if doing so will not expose unrelated applications.

### Recording evidence log

Record alongside the private video:

| Field | Value |
| --- | --- |
| Date/time and timezone | `[RECORDING_TIME]` |
| Build/commit | `[DEPLOYED_COMMIT]` |
| Application type | Sandbox / production draft beta |
| Test seller alias | Non-sensitive alias only |
| Steps passed | Authorization / health / marketplaces / orders / inventory / disconnect / renewal |
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
| Tenant-bound identity | `src/identity.ts`, `src/http.ts` | Agent Token validation screenshot/log without token |
| Seller ownership check | `src/tools.ts`, ownership tests | Cross-tenant rejection test result |
| Encrypted refresh token | `../amazon-oauth-service/server.mjs`, `src/token-store.ts` | File permissions and ciphertext inspection, no value copied |
| Credential-safe logs | `src/logger.ts`, HTTP/LWA tests | Sanitized production log sample |
| Non-PII output projection | `src/safe-output.ts`, projection tests | Recorded order/inventory response with no PII |
| Disconnect and cache invalidation | `src/oauth-client.ts`, `src/lwa.ts`, tests | Video steps 7–9 |
| Internal OAuth management API | `../amazon-oauth-service/server.mjs`, nginx/systemd config | Public `/internal/amazon/*` returns 404 |
| Read-only product scope | Tool annotations and `README.md` | Video shows no write action |

## 11. Final submission checklist

- [ ] Legal organization name and product brand are final and consistent.
- [ ] Organization website resolves over HTTPS and identifies the same entity.
- [ ] `[PRIVACY_POLICY_URL]`, `[TERMS_URL]`, `[DATA_DELETION_URL]` are public and reviewed.
- [ ] `[SECURITY_EMAIL]` is monitored and tested.
- [ ] Retention periods and external sharing/subprocessors are confirmed.
- [ ] OAuth Login URI and Redirect URI exactly match the deployed routes.
- [ ] M4-T1 sandbox authorization/disconnect/reauthorization passes.
- [ ] Legacy authentication is disabled in production.
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
- [Listings Items read integration](listings-items-integration.md)
