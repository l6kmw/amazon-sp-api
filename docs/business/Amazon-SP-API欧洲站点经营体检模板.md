# Amazon SP-API 欧洲站点经营体检模板

> 生成时间：`<YYYY-MM-DD HH:mm TZ>`
>
> 数据范围：只读 Sellers、Orders、FBA Inventory，以及可选 Listings Items。
>
> 使用说明：若未开启 `AMAZON_ENABLE_LISTINGS_TOOLS` 或未执行 `includeListings=true`，Listings 列必须填写“未检查”，不得根据订单或 FBA 库存为空推断账号没有 Listing。

## 结论

- 连接健康：`<ok / failed>`
- SP-API 区域：`<eu / 多区域>`
- 参与 Marketplace：`<N/N>`
- 订单：最近 `<N>` 天首批抽样 `<N>` 条；不是精确总数
- FBA 库存：`<未检查 / 空 / N 条汇总>`
- Listings：`<未检查 / 首批抽样为空 / 抽样 N 个，其中 BUYABLE N 个、含问题代码 N 个>`
- 数据边界：Listings 每个 Marketplace 最多抽样首批 20 个；若 `hasMore=true`，必须继续使用 `amazon_search_listings` 分页查看，报告不得把样本数写成精确总数

## 站点明细

| 国家/地区 | 站点 | Marketplace ID | 参与 | Listing 抽样数 | BUYABLE 样本 | 含问题代码样本 | Listings 有下一页 | 近 N 天订单抽样 | FBA 库存记录 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| `<国家>` | `<Amazon 域名>` | `<Marketplace ID>` | `<是/否>` | `<未检查或 0–20>` | `<未检查或 0–20>` | `<未检查或 0–20>` | `<未检查/是/否>` | `<N>` | `<N>` |

> “Listing 抽样数”“BUYABLE 样本”“含问题代码样本”只能来自 `amazon_business_snapshot(includeListings=true)` 的 `countsByMarketplace` 或 `amazon_search_listings` 的安全投影。不要复制 Seller SKU、标题、图片、issue message、`attributes`、`offers` 或原始响应到体检报告。

## Listings 诊断

- Feature flag：`<关闭 / 开启>`
- 检查 Marketplace 数：`<N>`
- Listing 首批样本数：`<N>`
- 有 Listing 样本的 Marketplace：`<N>`
- BUYABLE 样本数：`<N>`
- 含问题代码样本数：`<N>`
- 任一 Marketplace 有下一页：`<是 / 否>`
- 后续动作：
  - `hasMore=true`：逐站调用 `amazon_search_listings` 并使用 `pageToken` 继续；
  - 需要检查某个已知 SKU：调用 `amazon_get_listing_item`；
  - 样本为空：只表述“首批抽样为空”，并在 Seller Central 交叉核对，不得推断全账号没有 Listing；
  - 403：记录安全错误状态并检查卖家归属、现有“库存和订单追踪”角色和授权，不粘贴 Amazon 原始错误体。

## 订单与库存

- 查询窗口：`<开始时间>` 至 `<结束时间>`
- 订单分页状态：`<hasMore>`
- FBA 库存检查 Marketplace 数：`<N>`
- 注意：Listings fulfillment availability 不等同于 FBA Inventory 的完整库存，也不能代表全部渠道精确可售量。

## 数据采集验证

- MCP 版本/提交：`<commit>`
- Listings 工具开关：`<true/false>`
- MCP 请求数：`<N>`
- Amazon SP-API HTTP 200：`<N>`
- 429/5xx 与重试：`<N / 无>`
- 验证状态：`<fixture / 静态沙盒 / 生产 beta>`
- 未验证项：`<例如：账号无真实 Listing，未验证 getListingsItem 和分页>`

## 数据边界

本模板仅允许记录非 PII、安全投影或聚合结果。不得包含买家、收件人、地址、支付、追踪号、凭证、Seller SKU、Listing 原始 `attributes`/`offers`、issue 自由文本或上游原始错误体。订单与 Listings 数量均可能是有界抽样，不代表精确总数；FBM 和所有渠道库存仍不在当前诊断范围内。
