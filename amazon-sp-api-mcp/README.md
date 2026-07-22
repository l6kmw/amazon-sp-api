# amazon-sp-api-mcp

Amazon Selling Partner API 的 **Streamable HTTP MCP** 服务（本 monorepo 子包）。

完整项目说明与部署请看仓库根目录：

- **[README.md](../README.md)** — 简介与快速部署  
- **[docs/operations/DEPLOYMENT.md](../docs/operations/DEPLOYMENT.md)** — 完整部署指南  
- **[docs/README.md](../docs/README.md)** — 文档总目录  

## 本包职责

- MCP 工具：身份、账号列表、连接健康、订单 / 库存 / Marketplace，可选 Listings  
- ConnectedAccount 路径（feature flag）：Employee JWT、Connected Account API、`account_id` 归属  
- 与同仓库 `amazon-oauth-service` 配合：加密 Token、授权回调  

## 本地开发

要求 Node.js ≥ 22。

```bash
cd amazon-sp-api-mcp
npm ci
npm test
npm run typecheck
npm run build
```

生产/联调配置由仓库根目录 `config.yaml` + Docker Compose 注入，不要把密钥写进本目录。

## 安全边界

- 不返回 Access / Refresh Token、JWT、完整买家 PII  
- ConnectedAccount 工具只用 `account_id`；旧实现兼容可用 `sellingPartnerId`  
- `CONNECTED_ACCOUNT_ENABLED` 默认关闭，未解锁前勿对生产调用方开启  
