# Listings Items 只读接入说明

> M3-T1 调研结论，核验日期：2026-07-21。范围仅限 `getListingsItem` 与 `searchListingsItems`；不包含创建、更新或删除 Listing。

## 结论

- 采用 **Listings Items API v2021-08-01**，支持 NA、EU、FE。
- 两个只读操作均可使用现有 **Inventory and Order Tracking（库存和订单追踪）** 角色；官方角色映射也接受 Product Listing，但本项目无需为只读接入新增角色。
- 两个操作不在受限 PII 操作范围内，使用普通 LWA access token，**不申请 Restricted Role，也不获取 RDT**。
- Amazon 官方 OpenAPI 模型为两个操作提供静态沙盒响应，可先做契约验证；真实卖家数据和权限仍需生产 beta 回归。

## API 契约

| MCP 计划工具 | SP-API operation | 方法与路径 | 必填参数 |
| --- | --- | --- | --- |
| `amazon_get_listing_item` | `getListingsItem` | `GET /listings/2021-08-01/items/{sellerId}/{sku}` | `sellerId`、URL 编码后的 `sku`、单个 `marketplaceIds` |
| `amazon_search_listings` | `searchListingsItems` | `GET /listings/2021-08-01/items/{sellerId}` | `sellerId`、单个 `marketplaceIds`；按需传标识、状态、时间窗或分页参数 |

实现约束：

- 服务继续从租户连接解析 `sellerId`，调用前执行连接归属校验；不得信任任意外部 seller ID。
- `marketplaceIds` 在这两个操作中最多一个；跨站点查询由 MCP 按站点编排，不向单次请求塞多个站点。
- `searchListingsItems` 分页使用 `pageSize`（官方模型最大 20）和 Amazon 返回的 `pageToken`，MCP 原样映射为稳定分页字段。
- 首版 `includedData` 只请求实现确实投影的数据。默认 `summaries`；诊断需要时可增加 `issues`、`fulfillmentAvailability`。`attributes`、`offers`、`procurement`、`relationships`、`productTypes` 不默认请求。
- SKU 是路径参数时必须使用 `encodeURIComponent` 等价编码，不能手工拼接。

## 配额

Amazon 的 Listings Items Rate Limits 页面当前列出：

| 操作 | account-application pair | application | burst |
| --- | ---: | ---: | ---: |
| `getListingsItem` | 5 req/s | 100 req/s | 5 |
| `searchListingsItems` | 5 req/s | 100 req/s | 5 |

配额可能按账户动态调整；运行时以响应头 `x-amzn-RateLimit-Limit` 和 HTTP 429 为准。不要用静态沙盒做容量测试；Amazon 托管沙盒统一上限为 5 req/s、burst 15。

> 官方 OpenAPI operation 描述曾与专门 Rate Limits 页面出现 burst 差异；本项目以专门 Rate Limits 页面为规划基线，以实际响应头为运行时事实。

## 权限与 RDT

官方 operation role mapping 对两个只读操作给出的角色是“至少一个”：

- Inventory and Order Tracking；或
- Product Listing。

当前应用已经具备 Inventory and Order Tracking，因此 M3 只读工具**无需新增角色申请**。只有未来引入需要 Product Listing 的写操作或其他接口时，才重新评估并按最小权限申请。

RDT 仅用于返回客户 PII 的 restricted operation。上述 Listings Items 只读操作返回卖家 Listing 数据，不属于 restricted operation；本项目不得为它们申请受限角色或引入 Tokens API。

## 安全输出白名单

MCP 必须新建显式投影，禁止透传上游 JSON。首版允许输出：

- 顶层：`sku`、`summaries`、`issues`、`fulfillmentAvailability`、分页信息；
- Summary：`marketplaceId`、`asin`、`productType`、`conditionType`、`status`、`itemName`、`createdDate`、`lastUpdatedDate`、`mainImage.link`；
- Issue：仅 `code`、`severity`、`categories`、`attributeNames`；**不输出本地化 message、原始 details 或任意未知字段**；
- Fulfillment availability：`fulfillmentChannelCode`、`quantity`。

首版拒绝/丢弃：任意未知字段、未经审查的完整 `attributes`、自由文本 issue message/details、买家或收件人数据、凭证、请求头和上游原始错误体。

注意：Listings Items 的 fulfillment availability 不等同于 FBA Inventory API 的完整库存详情；工具描述不得把它宣传为所有渠道的精确可售库存。

## 错误处理

官方列出的响应状态为 `200`、`400`、`403`、`404`、`413`、`415`、`429`、`500`、`503`。M3 实现按现有稳定错误码映射：

| 上游状态 | MCP 处理 |
| --- | --- |
| 400 / 413 / 415 | `INVALID_FILTER`，不可重试；不透传原始请求或错误体 |
| 403 | `UPSTREAM_SP_API`，不可自动重试；提示检查 seller 归属、授权角色和 token |
| 404 | `UPSTREAM_SP_API`，不可重试；表示该站点/SKU 未找到，不等同于未授权 |
| 429 | `RATE_LIMITED`，可重试；优先使用 `Retry-After` |
| 500 / 503 | `UPSTREAM_SP_API`，可重试；保留 request ID 到结构化日志，不返回敏感上下文 |

## 沙盒与验收

官方 OpenAPI 模型为两个 operation 都声明了 `x-amzn-api-sandbox` 静态响应，因此可以验证：路径、必填参数、响应解析、错误映射和投影白名单。静态沙盒不证明真实角色授权、真实 Listing 存在或实际配额。

M3-T2/T4 验收覆盖：

1. [x] 模型 fixture 的成功响应与安全投影；
2. [x] `BadSKU`/400、413、415 无效请求映射为 `INVALID_FILTER`，不透传 Amazon 原始 message；
3. [x] 未知字段、`attributes`、`offers` 与 issue 自由文本被投影丢弃；
4. [x] 跨租户 seller 在发起 SP-API 请求前失败；
5. [x] feature flag 关闭时工具不注册，开启后只读 annotations 可见；
6. [x] 生产 beta 对一个自有测试卖家的参与 Marketplace 完成 `searchListingsItems` HTTP 200 等价空样本验证；
7. [ ] 真实 `getListingsItem` 与非空分页：当前 beta 账号无 Listing，无法在不伪造 SKU 的情况下完成，保留为出现真实 Listing 后的数据条件验证。

### 生产 beta 验证记录（2026-07-21）

- 通过受保护的公网 Streamable HTTP MCP 连接执行，无写操作；输出记录不保存 tenant、seller、Marketplace ID、SKU 或 Token。
- `tools/list` 返回 16 个工具，`amazon_search_listings` 与 `amazon_get_listing_item` 均可见。
- 对一个真实参与 Marketplace 调用 `amazon_search_listings(pageSize=20)` 成功，Amazon HTTP 200 等价结果为 0 个样本、无下一页；安全检查未观察到买家/收件人字段、`attributes`、`offers`、issue message/details 或其他禁止字段。
- 因搜索样本为空，没有可安全复用的真实 Seller SKU，所以没有调用 `amazon_get_listing_item`；不得把这一项记录为通过。
- 部署中的 `amazon_business_snapshot(includeListings=true)` 尚未返回 M3-T3 聚合字段，表明生产实例落后于本地提交；M3-T3 上线后仍需补一次 snapshot beta 回归。
- 本记录满足 M3-T4“至少一次沙盒或 beta HTTP 200”的最低门槛，但不代表真实 get、分页、非空投影或所有 Marketplace 均已验证。

## 官方依据

- [Listings Items API v2021-08-01 reference](https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference)
- [`getListingsItem`](https://developer-docs.amazon.com/sp-api/reference/getlistingsitem)
- [`searchListingsItems`](https://developer-docs.amazon.com/sp-api/reference/searchlistingsitems)
- [Listings Items API rate limits](https://developer-docs.amazon.com/sp-api/docs/listings-items-api-rate-limits)
- [Role mappings for SP-API operations](https://developer-docs.amazon.com/sp-api/docs/role-mappings)
- [Tokens API / Restricted Data Token guide](https://developer-docs.amazon.com/sp-api/docs/tokens-api-use-case-guide)
- [SP-API sandbox](https://developer-docs.amazon.com/sp-api/docs/the-selling-partner-api-sandbox)
- [Amazon 官方 OpenAPI 模型](https://github.com/amzn/selling-partner-api-models/blob/main/models/listings-items-api-model/listingsItems_2021-08-01.json)
