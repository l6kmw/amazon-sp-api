# Amazon SP-API Seller 只读能力与角色矩阵

## 冻结基线

本服务以 Amazon 官方 [`selling-partner-api-models`](https://github.com/amzn/selling-partner-api-models) 提交 `6ad2ee14835a9aa31889ae5607ea4e1fcc90f3ad` 为冻结基线。代码生成器共发现 353 个 operation，其中 93 个纳入 Seller 只读能力，260 个有明确排除理由。任何未分类 operation、总数改变或基线 commit 不匹配都会使生成/测试失败。

机器可读的完整矩阵位于 [`vendor/amazon-sp-api-models/operations.json`](../vendor/amazon-sp-api-models/operations.json)，每项都记录 model/version、method、path、角色、区域、数据等级、重试策略和纳入/排除理由。运行时注册表位于 [`src/generated/sp-api-registry.ts`](../src/generated/sp-api-registry.ts)，两者都由 [`scripts/generate-sp-api-registry.ts`](../scripts/generate-sp-api-registry.ts) 生成，不应手工修改。快照授权条款见 [`vendor/amazon-sp-api-models/LICENSE`](../vendor/amazon-sp-api-models/LICENSE) 和 [`NOTICE`](../vendor/amazon-sp-api-models/NOTICE)。

## MCP 工具模型

- `amazon_get_read_capabilities` 返回可用 action、所需 Amazon 角色、支持区域以及 `unknown / available / permission_required` 状态，不会为探测权限而批量请求 Amazon。
- 17 个领域工具命名为 `amazon_<domain>_read`。输入必须包含 ConnectedAccount `account_id`、区域和该领域注册的 `action`。
- action 是生成的枚举；调用方不能指定 URL、HTTP method、任意 path 或 Authorization Header。选定 action 后，path/query/body 按对应官方模型二次严格校验。
- `shipping` 与 `services` 领域工具为固定目录的占位边界；当前基线下无符合“Seller、非 Restricted、无副作用”的 action，因此不能执行任何操作。

## 领域覆盖与申请角色

| 领域工具 | 纳入数 | 主要 Amazon 角色 | 能力概要 |
|---|---:|---|---|
| `amazon_seller_read` | 2 | Selling Partner Insights | 账号与 Marketplace 参与信息 |
| `amazon_catalog_read` | 5 | Product Listing | Catalog Items、Product Type Definitions、Vehicles |
| `amazon_listings_read` | 3 | Product Listing | Listing 详情、搜索和限制；固定启用 |
| `amazon_orders_read` | 2 | Inventory and Order Tracking | Orders v2026 非 PII 订单和搜索 |
| `amazon_inventory_read` | 3 | Inventory and Order Tracking | FBA 库存与 Supply Sources 读取 |
| `amazon_pricing_read` | 11 | Pricing | 竞价、Offer、定价与费用估算 |
| `amazon_analytics_read` | 11 | Brand Analytics / Selling Partner Insights | 客户反馈、补货与订单指标 |
| `amazon_finances_read` | 1 | Finance and Accounting | Finances v2024 Transactions；不含旧 v0 |
| `amazon_warehousing_read` | 10 | Amazon Warehousing and Distribution | AWD 入/出库、补货、库存和合格性查询 |
| `amazon_fulfillment_read` | 26 | Amazon Fulfillment / Inventory and Order Tracking | FBA Inbound、配送预览、装箱、安置和运输查询 |
| `amazon_shipping_read` | 0 | — | 当前操作因 Restricted/业务写入被排除 |
| `amazon_services_read` | 0 | — | 当前操作因 Restricted/业务写入被排除 |
| `amazon_content_read` | 5 | Product Listing | A+ Content 读取、搜索与无副作用验证 |
| `amazon_reports_read` | 5 | Reports；角色随 report type | 只允许列表中的 Seller 非受限报表，支持创建/查询/取消/分页读取 |
| `amazon_data_kiosk_read` | 5 | Brand Analytics / Selling Partner Insights | 仅冻结 Seller GraphQL schema，支持创建/查询/取消/分页读取 |
| `amazon_feeds_read` | 3 | Feeds；角色随 feed type | 只读取已有 Feed 任务和允许的文本文档，不创建 Feed |
| `amazon_integrations_read` | 1 | Notifications；角色随 notification type | 只读 Seller Subscription；排除 grantless 应用控制面和所有创建、修改、删除操作 |

角色申请必须以真实产品功能为准，不应为“未来可能使用”预申请。Amazon 返回 403 时，服务统一返回 `AMAZON_ROLE_REQUIRED`、operation 和所需角色，不回显原始 Amazon 响应。新角色加入应用后，已有卖家需重新授权才能使用对应 action。角色对应关系应同时核对 [Amazon 官方 Role mappings](https://developer-docs.amazon.com/sp-api/docs/role-mappings)。

## 排除边界

以下能力不进入运行注册表：

- Vendor API、Tokens/RDT、仅 Restricted 角色可用的操作，以及必须接受/返回买家、收件人、地址、电话、邮箱、支付标识或无法安全过滤二进制文档的操作。
- Catalog v0、Orders v0、Finances v0 以及有受支持新版本替代的旧版本。同步时必须检查 [SP-API deprecations](https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations)。
- 任何修改业务状态的 operation、报表计划、通知订阅/目标写入、Feed 创建与业务提交，以及不属于 Seller 账号上下文的 grantless 应用控制面读取。
- 只例外允许无业务副作用的 POST/PUT 查询，以及 `createQuery/cancelQuery`、`createReport/cancelReport` 这些临时读取任务管理操作。

## 数据与执行安全

- Orders v2026 拒绝 `BUYER`、`RECIPIENT`、`PACKAGES`、`PAYMENT` 数据段。响应先按冻结官方 schema 删除未知字段，再按 operation 安全规则删除 PII 和预签名 URL。
- Data Kiosk 只允许冻结的 Seller schema；拒绝 mutation、subscription、introspection、未知 schema、超过 8,000 字符、12 层深度或 200 字段的 GraphQL。
- Reports、Data Kiosk 和允许的文本 Feed 文档无状态分页：每页不超过 200 条或 256 KiB，游标 15 分钟过期，不落盘、不记录正文、不返回 Amazon 预签名 URL。游标使用从 credential keyring 派生的独立 AES-GCM 密钥，绑定员工、账号、operation、document、偏移和过期时间。
- 每租户限制固定为 120 请求/分钟、8 并发；连接缓存 30 秒，区域缓存 24 小时。SP-API 客户端按 operation 和 Amazon usage-plan Header 自适应限流。
- GET 与明确幂等查询可重试；创建 Report/Data Kiosk 任务遇到结果不确定的失败时不自动重放。

## 官方模型同步流程

1. 在独立临时目录获取官方仓库，明确 checkout 待审计的 commit；不使用浮动分支直接生成发布产物。
2. 审查新增/删除/变更的 operation、角色、弃用日期、Restricted/Vendor/PII 边界和副作用，为每项给出明确纳入或排除理由。
3. 在生成器中更新冻结 commit、预期 operation 总数和安全允许表，然后运行：

   ```bash
   bun run generate:sp-api -- /absolute/path/to/selling-partner-api-models
   ```

4. 审查 `operations.json` 和生成注册表差异，补齐 operation 契约、角色、PII、重试、分页和密钥轮换测试，再执行完整发布门禁。

官方新增操作不会在运行时自动出现；只有经过上述同步、角色审计和安全分类后才能发布。
