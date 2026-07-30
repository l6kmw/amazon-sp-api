# Amazon SP-API 文档目录

本目录集中管理仓库内业务与工程文档；应用源码和包配置均位于仓库根目录。

项目简介与快速部署见仓库根目录 **[README.md](../README.md)**。  
完整部署见 **[operations/DEPLOYMENT.md](./operations/DEPLOYMENT.md)**。

## 分类

| 目录 | 内容 |
|---|---|
| [operations/](./operations/) | **部署指南**、运维 runbook、日常管理 |
| [connected-account/](./connected-account/) | ConnectedAccount 设计规格、验收矩阵与审核材料 |
| [scripts/](./scripts/) | 与脚本相关的来源说明（脚本本体仍在仓库 `scripts/`） |

## 快速入口

| 文档 | 路径 |
|---|---|
| **部署指南（主文档）** | [operations/DEPLOYMENT.md](./operations/DEPLOYMENT.md) |
| Seller 全量只读能力与角色矩阵 | [SP-API-READ-CAPABILITIES.md](./SP-API-READ-CAPABILITIES.md) |
| 管理与上线清单 | [operations/Amazon-SP-API管理.md](./operations/Amazon-SP-API管理.md) |
| ConnectedAccount 设计规格 | [connected-account/connected-account-account-mcp-design-spec.md](./connected-account/connected-account-account-mcp-design-spec.md) |
| 验收矩阵 | [connected-account/connected-account-acceptance-matrix.md](./connected-account/connected-account-acceptance-matrix.md) |
| Amazon 生产应用审核包 | [connected-account/production-app-review-package.md](./connected-account/production-app-review-package.md) |
| 指标与告警 | [operations/alerts-runbook.md](./operations/alerts-runbook.md) |
| JWT 轮换 | [operations/jwt-key-rotation-runbook.md](./operations/jwt-key-rotation-runbook.md) |

## 约定

- 新增 Markdown 优先放入本目录对应分类，避免再散落在仓库根目录。
- 当前应用为根目录单包；不要重新创建 OAuth/MCP 子包边界。
- 可执行脚本仍在 `../scripts/`；其 provenance 说明见 [scripts/SOURCE.md](./scripts/SOURCE.md)。
