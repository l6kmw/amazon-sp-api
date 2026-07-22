# Amazon SP-API MCP

独立部署的 Amazon SP-API MCP 服务。项目基于 Amazon 官方
[`amazon-data-kiosk-mcp-server`](https://github.com/amzn/selling-partner-api-samples/tree/main/use-cases/amazon-data-kiosk-mcp-server)
示例的 TypeScript 和 LWA 模式重新裁剪，只包含已申请的订单与库存范围。

已完成生产草稿 beta 的内部验证，但尚未通过 Amazon 生产应用审核，不得向外部卖家开放。

## 工具

| 工具 | 用途 |
| --- | --- |
| `amazon_get_identity` | 返回当前凭据的安全身份摘要，不返回 tenant、workspace、Token 或完整 JWT claims |
| `amazon_list_accounts` | 返回当前身份可用的规范 `account_id` 与安全卖家元数据 |
| `amazon_connection_health` | 强制刷新 LWA Token 并验证连接和区域 |
| `amazon_business_snapshot` | 汇总参与站点、订单抽样和 FBA 库存空态，并返回固定模板的中文短摘要与下一步工具指引；不返回 PII 或精确订单总数 |
| `amazon_list_marketplaces` | 查询卖家参与的 Amazon 站点 |
| `amazon_search_orders` | 使用 Orders API `2026-01-01` 查询订单 |
| `amazon_get_order` | 查询单个订单，移除买家与收件人信息 |
| `amazon_list_order_items` | 提取单个订单中的非 PII 商品明细 |
| `amazon_list_inventory_summaries` | 查询 FBA 库存汇总 |
| `amazon_get_inventory_by_sku` | 按 Seller SKU 查询 FBA 库存 |
| `amazon_search_listings` | 按单个 Marketplace 搜索 Listing 的安全摘要、问题代码和履约可用量；需开启 feature flag |
| `amazon_get_listing_item` | 按 Seller SKU 查询单个 Listing 的非 PII 白名单字段；需开启 feature flag |
| `amazon_create_authorization_url` | 创建当前 MCP 用户的一次性卖家授权地址 |
| `amazon_create_renewal_url` | 创建当前 MCP 用户的一次性重新授权入口 |
| `amazon_list_connections` | 列出当前 MCP 用户的卖家连接 |
| `amazon_disconnect_connection` | 显式确认后断开当前 MCP 用户的本地卖家连接，并返回 Seller Central 撤销授权入口 |

`amazon_business_snapshot.summary` 只根据安全聚合后的区域、站点数量、订单、库存和可选 Listing 抽样计数生成，不调用外部模型，也不会推断趋势或精确总量。`includeListings` 默认 `false`，并且只在 `AMAZON_ENABLE_LISTINGS_TOOLS=true` 时可用；开启后每个已选 Marketplace 最多抽样首批 20 个 Listing，汇总可购买样本和含问题代码的样本，并引导用户继续调用 `amazon_search_listings`。订单和库存仍分别使用 `amazon_search_orders`、`amazon_list_inventory_summaries` 查看明细。

默认 7 个 SP-API 数据工具、开启 Listings 后新增的 2 个工具，以及连接健康检查都声明为只读。单连接租户可以省略
`sellingPartnerId`，Marketplace 区域也可以自动识别；多连接租户必须明确选择卖家。
授权地址和连接列表不修改 Amazon 业务数据；
断开工具明确标记为破坏性操作，并要求 `confirmDisconnect=DISCONNECT`。订单搜索和
FBA 库存汇总默认只读取一页；`autoPage=true` 时最多自动读取 5 页，响应统一使用
`pagination.nextToken` 和 `pagination.hasMore`。项目不包含买家信息、收货地址、Listing 写操作、完整 Listing 原始响应、价格、消息、
发货确认或其他 Amazon 业务写操作。

## 本地验证

要求 Node.js 22 或更高版本：

```bash
npm install
npm test
npm run typecheck
npm run build
```

## 运行配置

复制 `.env.example` 中的变量名到受限环境文件，真实值不得写入 Git：

- `MCP_ALLOW_LEGACY_AUTH`：默认 `false`；生产环境只接受校验成功且携带租户 ID 的 `oat_*` 旧实现凭证。
- `MCP_AUTH_TOKEN`：仅在迁移期启用 legacy 鉴权时设置，必须是至少 32 字节的随机 Bearer Token。
- `MCP_LEGACY_TENANT_ID`：可选迁移租户绑定；未设置时 legacy 凭证会在 MCP 入口因缺少租户而被拒绝，不能调用任何工具。
- `AMAZON_ALLOWED_SELLING_PARTNER_IDS`：逗号分隔的平台级卖家硬允许列表；日常租户归属以 OAuth 连接列表为准。
- `AMAZON_ENABLE_LISTINGS_TOOLS`：默认 `false`；仅在 Listings 只读工具完成 beta 验证后设为 `true`，开启时工具数由 14 增至 16。
- `CONNECTED_ACCOUNT_ENABLED`：默认 `false`；M1–M4 阻断项清零且用户解锁前不得在生产开启。
- `CONNECTED_ACCOUNT_JWT_AUDIENCE`：ConnectedAccount Employee JWT 必须包含的 audience，仅在启用时必填。
- `CONNECTED_ACCOUNT_JWT_KEYS`：JSON 对象，按 `kid` 配置精确 `issuer` 与至少 32 字节 HS256 Secret；只通过受限部署 Secret 注入。
- `AMAZON_DATABASE_URL`：PostgreSQL 连接字符串；ConnectedAccount 开启时必填，作为 OAuth 连接、Attempt、Grant、Binding 和 Account 的持久化真相源。
- `AMAZON_REDIS_URL`：Redis 连接字符串；ConnectedAccount 开启时必填，用于 OAuth 短期 state/intent、LWA Access Token 共享缓存和多实例刷新锁。
- `AMAZON_REDIS_NAMESPACE`：Redis key 前缀，默认 `amazon-sp-api`，所有账号与租户组合均哈希后写入。
- `AMAZON_LWA_CLIENT_ID` / `AMAZON_LWA_CLIENT_SECRET`：SP-API 应用 LWA 凭证。
- `AMAZON_TOKEN_ENCRYPTION_KEY`：与 OAuth 服务相同的 32 字节加密密钥（当前为 legacy-unversioned envelope，无 `version/key_id`，M2-T2 完成前为上线阻断）。
- `AMAZON_TOKEN_STORE_FILE`：OAuth 服务生成的加密 Token 文件（兼容/回滚路径，不是生产唯一真相源）。
- `AMAZON_INTERNAL_SECRET`：MCP 与独立 OAuth 服务之间的回环接口密钥。
- `AMAZON_OAUTH_INTERNAL_URL`：独立 OAuth 服务的回环地址。
- `LEGACY_IDENTITY_VALIDATION_URL`：旧实现身份校验回环地址，只用于解析可信租户 ID。
- `LEGACY_IDENTITY_HEALTH_URL`：旧实现身份服务健康地址；legacy 关闭时纳入 `/readyz`。
- `MCP_TENANT_REQUESTS_PER_MINUTE`：每个租户每分钟最多接受的 MCP 请求数，默认 `120`。
- `MCP_TENANT_MAX_CONCURRENT_REQUESTS`：每个租户最多同时处理的 MCP 请求数，默认 `8`。

### ConnectedAccount 规格冻结（M0）

- 设计规格：[`../docs/connected-account/connected-account-account-mcp-design-spec.md`](../docs/connected-account/connected-account-account-mcp-design-spec.md)
- 验收矩阵：[`../docs/connected-account/connected-account-acceptance-matrix.md`](../docs/connected-account/connected-account-acceptance-matrix.md)
- 版本化证据：[`../docs/acceptance/`](../docs/acceptance/)
- 文档总目录：[`../docs/README.md`](../docs/README.md)
- 只读验收脚本（来自 skill，固定哈希）：仓库根目录 `scripts/verify_connected-account_account_mcp.py`
- `independentOwnerAuthorization=false`：同一 `selling_partner_id` 全局排他；跨 tenant 重新授权冲突
- 当前无 Amazon 业务写工具；确认值/幂等/revision 对 ConnectedAccount catalog 为不适用

服务默认只监听 `127.0.0.1:8789`：

```bash
npm start
```

MCP 端点为 `/mcp`。`/healthz` 与 `/mcp/healthz` 仅用于进程存活检查；内部 `/readyz` 会验证 Token
存储、32 字节加密密钥、OAuth 回环服务、已配置的 PostgreSQL/Redis，以及 legacy 关闭时的
旧实现身份服务。任一检查失败时 `/readyz` 返回 HTTP 503，
但不会调用 Amazon 公网，也不会在响应中泄露路径或凭证错误。生产反向代理片段和
systemd 单元分别在 `api.example.com.nginx`、`amazon-sp-api-mcp.service`。

部署后应在服务器本机执行：

```bash
curl --fail http://127.0.0.1:8789/healthz
curl --fail http://127.0.0.1:8789/readyz
```

公网 `https://api.example.com/healthz/amazon-mcp` 保持 liveness 语义；`/readyz` 不对公网
暴露，供部署验证和回环监控使用。

## 安全边界

- Refresh Token 从现有 AES-256-GCM Token Store 解密，不接受明文 Token 配置。
- SP-API 请求只使用 LWA Access Token，不使用 AWS Access Key 或 SigV4。
- Refresh Token 所有权与 LWA Access Token 缓存均按租户和卖家隔离；同一租户和卖家的并发 LWA 交换会合并为一次请求，失败不会缓存。
- OAuth 连接列表按租户在进程内缓存 30 秒，成功断开连接后立即失效；Token 文件仅在 `mtime + size` 变化时重新读取。
- 自动发现的 Amazon 区域按租户和卖家在进程内缓存 24 小时，断开连接或缓存区域探测失败时立即失效；服务重启会清空所有内存缓存。
- SP-API 400/413/415 统一映射为不可重试的 `INVALID_FILTER`；403/404 保持 `UPSTREAM_SP_API` 并通过安全 `details.status` 区分权限与不存在，不透传 Amazon 原始错误文本。
- 429 和 5xx 最多重试两次，遵守 `Retry-After`。
- MCP 入口支持旧实现 Agent Token，校验后只保留可信 `app_user.id` 作为租户 ID。
- 多站点订单查询必须位于同一个 Amazon 区域。
- 微信公众号服务不包含 Amazon 页面、路由、工具、业务代码或配置。
