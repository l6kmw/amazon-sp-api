# Amazon SP-API 文档目录

本目录集中管理仓库内业务与工程文档（不含各子包自带的 `README.md` / `LICENSE`）。

## 分类

| 目录 | 内容 |
|---|---|
| [plans/](./plans/) | 实施计划、严格完善计划 |
| [operations/](./operations/) | 部署、运维 runbook、日常管理 |
| [connected-account/](./connected-account/) | ConnectedAccount 设计规格、验收矩阵、审核材料、Listings 集成 |
| [acceptance/](./acceptance/) | 版本化验收证据与 canary 记录 |
| [business/](./business/) | 欧洲站点经营体检模板与报告 |
| [scripts/](./scripts/) | 与脚本相关的来源说明（脚本本体仍在仓库 `scripts/`） |

## 快速入口

| 文档 | 路径 |
|---|---|
| ConnectedAccount 严格完善计划 | [plans/Amazon-SP-API-ConnectedAccount严格完善计划.md](./plans/Amazon-SP-API-ConnectedAccount严格完善计划.md) |
| MCP 完善实现计划 | [plans/Amazon-SP-API-MCP完善实现计划.md](./plans/Amazon-SP-API-MCP完善实现计划.md) |
| Docker 部署 | [operations/DOCKER_DEPLOYMENT.md](./operations/DOCKER_DEPLOYMENT.md) |
| 管理与上线清单 | [operations/Amazon-SP-API管理.md](./operations/Amazon-SP-API管理.md) |
| ConnectedAccount 设计规格 | [connected-account/connected-account-account-mcp-design-spec.md](./connected-account/connected-account-account-mcp-design-spec.md) |
| 验收矩阵 | [connected-account/connected-account-acceptance-matrix.md](./connected-account/connected-account-acceptance-matrix.md) |
| 指标与告警 | [operations/alerts-runbook.md](./operations/alerts-runbook.md) |
| JWT 轮换 | [operations/jwt-key-rotation-runbook.md](./operations/jwt-key-rotation-runbook.md) |
| M4 技术总验收 | [acceptance/m4-tech-acceptance-2026-07-22.md](./acceptance/m4-tech-acceptance-2026-07-22.md) |

## 约定

- 新增 Markdown 优先放入本目录对应分类，避免再散落在仓库根目录。
- 子包 `amazon-sp-api-mcp/README.md` 只保留包级说明，并链接到此处。
- 可执行脚本仍在 `../scripts/`；其 provenance 说明见 [scripts/SOURCE.md](./scripts/SOURCE.md)。
