# ConnectedAccount 验收证据目录

每个 release 新增 `docs/acceptance/<release-id>.md`。

## 必填字段

| 字段 | 说明 |
|---|---|
| commit/release | Git commit SHA 或 release 标签 |
| 日期 | UTC 或本地明确时区 |
| 环境类型 | 本地 / example 临时 / 预生产 / 生产（默认不得开启 ConnectedAccount） |
| 测试命令 | 精确命令与通过/跳过数 |
| HTTP/MCP 安全摘要 | 状态码、公开字段、无 Secret |
| 脱敏扫描 | canary 命中数必须为 0 |
| 独立评分 | 按计划 100 分维度 |
| 已知限制 | 未完成项 |
| 阻断状态 | 是否允许请求开启 `CONNECTED_ACCOUNT_ENABLED` |

## 规则

- 不得粘贴 Token、Secret、授权码、数据库 URL、完整 JWT 或生产账号数据。
- 结论只允许：`通过`、`不适用（有设计依据）`、`阻断`。
- 技术总验收必须从规范 `assets/acceptance-matrix.md` 逐行复制后裁决，不得只用阶段摘要。
- M5 外部开放不因技术证据完成而自动解锁。

## 当前基线

见 `m0-baseline-2026-07-22.md`。
