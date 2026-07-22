# Amazon SP-API 管理

> 更新日期：2026-07-21
>
> 用途：集中管理 Amazon Solution Provider Portal 申请、SP-API 应用、OAuth URL、权限和上线验证。
>
> 安全边界：本文档不保存 Client Secret、Refresh Token、Access Token 或其他凭证。

## 1. 当前结论

- 应用对象：外部 Amazon 卖家通过 OAuth 授权的公共 SaaS。
- 首期边界：优先打通沙盒、订单和库存读取，不读取买家 PII。
- 权限原则：只申请已实现且必需的角色，未上线的功能不预先申请。
- Ads 边界：Amazon Ads 通过独立 Ads API 申请，不写入 SP-API 用例。
- 系统边界：Amazon MCP 和 OAuth 是独立服务；微信公众号服务不包含 Amazon 页面、路由、工具、业务代码或配置。
- 身份边界：Amazon MCP 仅通过回环身份接口校验旧实现 Agent Token，并将可信 `app_user.id` 作为租户 ID；不复用微信业务能力。
- OAuth 现状：独立的授权链接、连接列表和断开工具已部署；线上租户连接列表和 Marketplace 只读调用验证通过。

## 2. Solution Provider Portal 资料

| 字段 | 建议值 | 状态 |
| --- | --- | --- |
| 组织名称 | 营业执照上的完整法定名称 | 待确认 |
| 组织网站 | `https://connected-account.me` | 待验证公开合规页面 |
| 组织类型 | 公共解决方案提供商 | 已选择 |
| 授权模式 | Amazon OAuth，由卖家主动授权 | 已确定 |
| 外部共享方 | 上线前按实际云服务、数据库、日志和监控服务商填写 | 待确认 |
| 外部数据来源 | 如无 ERP、Shopify 等第三方数据，填写“无” | 待确认 |

## 3. SP-API 应用配置

| 字段 | 当前建议 |
| --- | --- |
| 应用名称 | `<你的应用名称>` |
| API 类型 | `SP API` |
| 应用类型 | 先创建`沙盒`；OAuth 端到端验证通过后再创建`生产`应用 |
| 支持的企业实体 | 只选`卖家` |
| 已申请角色 | `库存和订单追踪`（同时覆盖订单、库存及 Listings Items 两个只读 operation） |
| RDT 转授 | `不，我不会将 PII 的访问权限授予另一个开发者的应用程序` |
| OAuth 登录 URI | `https://api.example.com/oauth/amazon/login` |
| OAuth 重定向 URI | `https://api.example.com/oauth/amazon/callback` |

后续仅在功能真实上线且目标 operation 不被现有角色覆盖时增加角色：

- Listings 只读：`getListingsItem` / `searchListingsItems` 已实现并通过生产 beta 的 `searchListingsItems` HTTP 200 空样本验证；官方映射接受现有 `库存和订单追踪`，无需新增 `商品信息` 或受限角色，详见 [`../connected-account/listings-items-integration.md`](../connected-account/listings-items-integration.md)。
- `商品信息`：未来新增其他 Listing operation 时，按官方 operation role mapping 重新核对后再申请。
- `定价`：已实现价格读取、监控或卖家明确配置的调价。
- `洞察销售伙伴`：确实需要账户绩效数据。
- `财务与会计核算`：已实现财务报表。

不申请 AWD、卖家平台通知、买家沟通、付款、开放银行及受限角色，除非对应功能和合规控制已完成。

## 4. example URL 方案

推荐使用独立子域名 `api.example.com`，不修改 `example.com` 现有静态博客路由。

### 当前检查结果

| 检查项 | 2026-07-18 结果 | 结论 |
| --- | --- | --- |
| `https://example.com/` | HTTP 200，Cloudflare 前置 | 现有站点正常 |
| `api.example.com` DNS | 解析到 Cloudflare | DNS 已有解析结果 |
| `https://api.example.com/healthz` | HTTP 200 | 服务、Cloudflare 和源站 TLS 正常 |
| `https://api.example.com/healthz/amazon-mcp` | HTTP 200 | MCP、Nginx 和 Cloudflare 正常 |
| `api.example.com` 证书 | Let's Encrypt，2026-10-15 到期 | 已配置 Certbot 续期 |
| Amazon OAuth 服务 | systemd 运行，仅监听 `127.0.0.1:8788` | 已部署，LWA 凭证已配置 |
| Amazon 授权入口 | 由 MCP 返回 `https://api.example.com/oauth/amazon/start?intent=...` | 已部署，无效 intent 返回 400 |
| 内部绑定接口 | `127.0.0.1:8788/internal/amazon/*` | 回环调用正常，公网返回 404 |

TLS 和反向代理的已实施配置：

1. 源站使用 `/etc/letsencrypt/live/api.example.com/` 下的 Let's Encrypt 证书。
2. Cloudflare 通过 HTTPS 连接源站，公网验证已通过。
3. Nginx 将 `/oauth/amazon/` 和 `/healthz` 反向代理到本机 OAuth 服务。

Nginx 参考配置：

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location /oauth/amazon/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

服务器部署位置：

| 项目 | 路径 |
| --- | --- |
| 应用代码 | `/opt/amazon-oauth-service` |
| systemd 单元 | `/etc/systemd/system/amazon-oauth-service.service` |
| 受限环境文件 | `/etc/amazon-oauth-service.env`（`0600`） |
| 加密数据 | `/var/lib/amazon-oauth-service`（专用系统用户） |
| Nginx 站点 | `/etc/nginx/sites-available/api-example-amazon` |

## 5. OAuth 端点责任

### `GET /oauth/amazon/login`

- 接收 `amazon_callback_uri`、`amazon_state`、`selling_partner_id` 和可选 `version`。
- 直接消费 `api.example.com` 写入的 10 分钟 HttpOnly intent Cookie，不跳转到旧实现或微信公众号页面。
- 生成一次性、短时效的 OAuth `state`，服务端同时绑定可信 `app_user.id` 和 `selling_partner_id`。
- 将 `amazon_state` 原样返回 Amazon 提供的 `amazon_callback_uri`。
- 设置 `Referrer-Policy: no-referrer`。

### `GET /oauth/amazon/start`

- 接收 MCP 私有接口创建的一次性 intent。
- 在 `api.example.com` 设置 HttpOnly、Secure、SameSite=Lax Cookie 后跳转 Seller Central。
- 浏览器全程只访问 `api.example.com` 和 Amazon，不经过微信公众号服务。

### `GET /oauth/amazon/renew`

- 接收 MCP 私有接口创建的一次性 intent。
- 在 `api.example.com` 设置同样的安全 Cookie 后打开 Seller Central 的 Manage Your Apps。
- 用于已启用应用的 Re-Authorize 流程，避免把续期误当成首次授权而触发 `MD1000`。

### `GET /oauth/amazon/callback`

- 接收 `state`、`selling_partner_id` 和 `spapi_oauth_code`。
- 先校验回调路径和一次性 `state`，无效请求不得终止真实授权流程。
- 同时支持 Amazon 经过登录 URI 生成 OAuth state，以及已授权应用跳过登录 URI、直接返回初始 intent state 的流程；两者均只能消费一次。
- 在 5 分钟内用 `spapi_oauth_code` 换取 LWA Token。
- 按租户加密存储 Refresh Token，日志中不记录授权码、Token 或 Client Secret。
- 默认返回 `api.example.com` 托管的授权完成页面。

### Amazon MCP 连接工具

- `amazon_connection_health`：强制刷新 LWA Access Token，并验证卖家连接、区域和 Sellers API。
- `amazon_create_authorization_url`：为当前 MCP 用户创建一次性浏览器授权地址。
- `amazon_create_renewal_url`：为当前 MCP 用户创建一次性 Manage Your Apps 重新授权入口。
- `amazon_list_connections`：只列出当前 `app_user.id` 拥有的卖家连接元数据。
- `amazon_disconnect_connection`：要求显式确认后删除当前用户拥有的加密 Refresh Token。

Amazon 官方明确只有卖家可以彻底撤销公共应用 OAuth。MCP 断开会立即停止本地 API 使用；卖家如需在 Amazon 侧禁用授权，还要到 Seller Central 的 Manage Your Apps 操作。

## 6. 凭证管理

仅记录变量名，真实值使用服务器 Secret Manager、受限权限的环境文件或部署平台密钥管理：

```text
AMAZON_LWA_CLIENT_ID
AMAZON_LWA_CLIENT_SECRET
AMAZON_TOKEN_ENCRYPTION_KEY
AMAZON_OAUTH_REDIRECT_URI=https://api.example.com/oauth/amazon/callback
AMAZON_APPLICATION_ID
AMAZON_AUTHORIZATION_URI
AMAZON_APPLICATION_VERSION=beta
AMAZON_INTERNAL_SECRET
AMAZON_OAUTH_INTERNAL_URL=http://127.0.0.1:8788
LEGACY_IDENTITY_VALIDATION_URL=http://127.0.0.1:8080/api/v1/admin/session
```

不在本文档、Git 仓库、构建日志或应用日志中写入真实凭证。

## 7. 上线检查清单

- [x] 确认 `api.example.com` DNS 记录经 Cloudflare 到达正确源站。
- [x] 修复 Cloudflare HTTP 526，确认源站证书有效。
- [x] 实现并部署 `/oauth/amazon/login`。
- [x] 实现并部署 `/oauth/amazon/callback`。
- [x] 通过本地自动化测试验证无效 `state` 被拒绝，合法授权仍可继续。
- [x] 实现 Agent Token 身份校验、一次性 intent 和跨租户防护。
- [x] 从微信公众号服务移除 Amazon 页面、路由、业务代码和配置。
- [x] 实现独立 MCP 的授权链接、连接列表和断开工具。
- [x] 部署独立 OAuth 与 MCP，并验证微信公众号服务无 Amazon 入口。
- [x] 将生产草稿应用的 Amazon LWA Client ID 和 Client Secret 写入服务器 `0600` 环境文件。
- [x] 验证授权码能在 5 分钟内换取 Token。
- [x] 验证 Refresh Token 加密存储且日志无敏感信息。
- [ ] 在 Amazon 沙盒应用中填写两个 OAuth URI。
- [ ] 完成一次沙盒端到端授权、撤销和重新授权。
- [x] 完成生产草稿应用 beta OAuth 授权及订单、库存只读调用。
- [x] 完成 Listings Items 生产 beta 只读验证：工具可见，`searchListingsItems` 对参与 Marketplace 返回 HTTP 200 空样本；因账号无 Listing，未伪造 `getListingsItem` 或分页成功记录。
- [x] 使用临时 Agent Token 验证 MCP 租户连接列表和真实 Marketplace 读取，验证后残留为 0。
- [x] 完成 MCP 断开授权、失效和重新授权验证后再提交生产应用审核。
- [x] 目标旧实现用户重授权成功，回调写入 tenant 归属且重放返回 400。
- [x] 人工验证 MCP 断开、失效和重新授权恢复。
- [x] 完成无密钥生产审核包草稿：[`../connected-account/production-app-review-package.md`](../connected-account/production-app-review-package.md)。
- [ ] 发布并核验隐私政策、服务条款和数据删除说明 URL。
- [ ] 确认数据保留期限、外部共享方、真实安全联系人和事件通知流程。
- [ ] 按审核包脚本录制无凭证、无 PII 的端到端审核视频。

## 8. 非敏感标识记录

| 项目 | 值 |
| --- | --- |
| 沙盒 Application ID | `amzn1.sp.solution.example-sandbox` |
| 生产草稿 Application ID | `amzn1.sp.solution.example-production` |
| LWA Client ID / Secret | 已配置在服务器受限环境文件，不入 Git |
| 应用状态 | 沙盒已创建；生产应用为草稿 |
| 已申请角色 | 库存和订单追踪 |
| 生产草稿 beta 授权日期 | `2026-07-17` |
| 下次授权续期日期 | 待 Amazon 控制台确认 |

## 9. MCP 实现状态

本地目录：`amazon-sp-api-mcp/`

本地默认实现 12 个工具；`AMAZON_ENABLE_LISTINGS_TOOLS=true` 时增加
`amazon_search_listings` 与 `amazon_get_listing_item`，共 14 个。Listings 工具只调用
Listings Items API v2021-08-01 的只读 operation，单次仅查询一个 Marketplace，输出使用显式
白名单，并移除 `attributes`、`offers`、issue 自由文本和未知字段。业务快照的
`includeListings` 默认 `false`；开启后每站仅抽样首批 20 个 Listing 并返回聚合计数，不返回 SKU
或原始 Listing。7 个基础只读数据工具包括业务快照、卖家站点、订单搜索、订单详情、订单商品、
FBA 库存汇总和按 Seller SKU 查询库存；另有 1 个只读健康检查工具和 4 个连接管理工具。
订单搜索和 FBA 库存汇总默认只读取一页；可用 `autoPage=true` 自动合并最多 5 页，并统一返回
`pagination.nextToken` 与 `pagination.hasMore`。单连接租户可省略 `sellingPartnerId`，多连接租户
必须明确选择卖家。订单接口使用 Amazon 官方 `Orders 2026-01-01` 模型，不请求 `BUYER` 或
`RECIPIENT` 数据集，并在输出边界再次移除买家与收件人字段。

2026-07-21 使用现有生产草稿 beta 自有卖家执行无写操作验证：公网 MCP 返回 14 个工具，
Listings 两个工具均可见；对一个参与 Marketplace 调用 `amazon_search_listings` 成功返回 HTTP 200
等价结果，样本数为 0、无下一页且未观察到禁止字段。该账号当前无 Listing，因此无法安全取得
真实 SKU；`amazon_get_listing_item` 真实 200 与非空分页仍记为后续数据条件验证，不能把空样本
写成完整 get/search/pagination 验证。`amazon_business_snapshot(includeListings=true)` 的公网部署
结果未包含 Listings 聚合，说明服务器部署版本尚未包含 M3-T3；本地实现和测试已通过，但部署前
不得宣称 snapshot Listings 已完成生产验证。

实现边界：

- MCP 采用 Streamable HTTP，入口支持旧实现 Agent Token；服务端只复用身份校验结果，不依赖微信业务代码。
- 复用 OAuth 服务的 AES-256-GCM Token Store，不保存明文 Refresh Token。
- Refresh Token 所有权和 LWA Access Token 缓存均按租户隔离。
- MCP 断开连接成功后，立即按 `tenantId + sellingPartnerId` 清除对应 LWA Access Token 缓存。
- 只允许配置在 `AMAZON_ALLOWED_SELLING_PARTNER_IDS` 中的卖家。
- 服务仅监听 `127.0.0.1:8789`，公网地址为 `https://api.example.com/mcp/amazon`。
- 11 工具独立版本 `2e1db91` 已部署到 `/opt/amazon-sp-api-mcp`；OAuth handoff 版本为 `24ba5f7`。
- TypeScript `7.0.2` 工具链版本 `3a6ddf3` 已于 `2026-07-20` 部署；服务器 Node.js 和 npm 版本保持不变。
- 租户强绑定、响应白名单、凭证安全结构化日志和租户限流版本 `87bdd7f` 已于 `2026-07-20` 部署；回滚目录为 `/opt/amazon-sp-api-mcp.backup-20260720T150015`。
- 微信公众号服务已部署清理版本 `24f6e4f`，旧 `/api/v1/amazon/*` 路由公网返回 404。
- 公网 MCP 地址为 `https://api.example.com/mcp/amazon`；公网 `https://api.example.com/healthz/amazon-mcp` 仅表示 MCP 进程、Nginx 和 Cloudflare 存活。2026-07-21 MCP `tools/list` 实测返回 14 个工具；health 响应中的工具数必须随部署配置同步核对。
- 部署与回环监控使用内部 `http://127.0.0.1:8789/readyz` 判定就绪；它要求 Token 文件可读、32 字节加密密钥可解析，且 OAuth `/healthz` 明确返回 `status=ok` 与 `lwaConfigured=true`，失败返回 HTTP 503。该端点不调用 Amazon 公网，也不经 Nginx 暴露。
- 每次部署后在服务器执行 `curl --fail http://127.0.0.1:8789/healthz` 与 `curl --fail http://127.0.0.1:8789/readyz`；前者成功而后者失败时不得切流，应检查 Token 文件权限、加密密钥和 OAuth 服务配置。
- 生产必须保持 `MCP_ALLOW_LEGACY_AUTH=false`，仅接受校验成功且携带 tenant 的旧实现 Agent Token；不存在无租户共享 Token 的只读兼容路径。迁移期如临时开启 legacy，必须同时配置至少 32 字节的 `MCP_AUTH_TOKEN` 与唯一 `MCP_LEGACY_TENANT_ID`，窗口结束后关闭开关并验证 legacy 返回 401/403。
- 生产草稿应用 beta 授权已完成，服务器有 `1` 条 AES-256-GCM 加密 Refresh Token 记录。
- 已将真实卖家 ID 写入 MCP 允许列表；现有 Token 已绑定目标旧实现用户的可信 tenant 归属。
- 卖家属于 EU 区域，共返回 11 个已参与且未暂停的 Marketplace。
- 英国站 Orders 和 FBA Inventory 均完成真实 HTTP 200 验证；最近 30 天订单数和库存汇总数均为 `0`。
- Listings Items `searchListingsItems` 已完成生产 beta 真实 HTTP 200 空样本验证；真实 `getListingsItem` 和分页验证因账号无 Listing 暂缓，继续由 feature flag 和只读边界控制。
- 当前 Codex 已配置 `amazon` Streamable HTTP 连接，Bearer Token 通过 `AMAZON_MCP_TOKEN` 环境变量读取；明文只存于 macOS Keychain。
- 断开授权、失效和重新授权验证已完成；向外部客户开放仍需完成生产应用审核。
