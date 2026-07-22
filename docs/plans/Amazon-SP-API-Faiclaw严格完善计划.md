# Amazon SP-API ConnectedAccount 账号型 MCP 严格完善计划

> 计划基线：2026-07-22
>
> 唯一规范来源：`/Users/l6kmw/Downloads/build-connected-account-account-mcp`
>
> 项目目录：`amazon-sp-api/`
>
> 当前发布约束：`CONNECTED_ACCOUNT_ENABLED=false`；外部开放阶段继续锁定，只有用户明确解锁后才能执行真实沙盒、审核提交、外部卖家测试或产品放量。

## 1. 目标

将现有 Amazon OAuth + SP-API MCP 完善为严格符合 ConnectedAccount Connected Account Protocol v1 的账号型 MCP，并形成可审计、可验证、可回滚的交付证据。

规范优先级如下：

1. `build-connected-account-account-mcp/SKILL.md` 的不可妥协边界；
2. `references/connected-account-protocol-v1.md` 的固定路径、字段、JWT 和 Scope；
3. `references/mcp-contracts.md` 的工具 Schema、错误与恢复契约；
4. `references/security-operations.md` 的 Token、Secret、并发、日志、轮换和发布要求；
5. `assets/acceptance-matrix.md` 的验收项和上线阻断条件；
6. Amazon SP-API 官方文档中的授权、错误码和角色规则。

不得通过放宽 JWT、Scope、账号归属、日志脱敏或验收标准来绕过失败。

## 2. 当前状态

### 2.1 已完成并需要保持回归的能力

- Discovery、HS256 Employee JWT、`kid`、issuer、audience、时间和四类 Scope 校验；
- `/connected-account/v1` 账号生命周期 API；
- External Account、Grant、Binding、Attempt 分离建模；
- `issuer + employee_id` 隔离和 Binding + Grant + Account 联合归属校验；
- `amazon_get_identity`、`amazon_list_accounts`；
- ConnectedAccount 使用规范 `account_id`，旧实现兼容路径使用 `sellingPartnerId`；
- OAuth state/intent 单次消费、回调 Origin、CSP、no-referrer、no-store；
- PostgreSQL 生产持久化、Redis state/cache/lock、多实例 LWA singleflight；
- Docker 单容器双进程、非 root、只读根文件系统和最终镜像导入验证。

### 2.2 当前阻断或部分完成项

| 优先级 | 缺口 | 当前状态 | 是否阻断 ConnectedAccount 正式开启 |
|---|---|---|---:|
| P0 | 业务工具 output Schema、structuredContent、错误契约 | M1 Schema + 错误契约完成；上线仍受 M2/M3/M4 阻断 | 是 |
| P0 | Refresh Token 加密 envelope 的 `version/key_id` 与渐进轮换 | M2 完成（v2 双读 + rotate 脚本） | 否（运维演练仍建议做） |
| P0 | Docker YAML 表达 PostgreSQL、Redis、ConnectedAccount 和 keyring | M3 loader/Compose/文档已完成；全量故障注入可再补 | 否（建议补 compose 故障注入证据） |
| P1 | Amazon 明确 Access Token 失效后的单次强刷恢复 | 未完成 | 应在开启前完成 |
| P1 | JWT 双 key 轮换流程、YAML 和演练证据 | 底层能力已有，运维未闭环 | 是 |
| P1 | OAuth/MCP 指标、告警、完整 request ID 和事件字典 | 部分 | 是 |
| P1 | CI 与 PostgreSQL/Redis 集成测试证据 | 未完成 | 发布门禁缺口 |
| P2 | 文档中的历史状态和当前架构不一致 | M0 已对齐主规格；审核包仍待 M5 | 审核材料部分 |
| M5 | 沙盒 E2E、政策 URL、录屏、外部卖家、legacy 下线、放量 | 暂缓 | 对外开放阻断 |

### 2.3 阶段进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| M0 规格与证据基线 | **完成（本地）** | T1–T4：设计冻结、只读脚本、证据目录、协议回归；评分 94 |
| M1 MCP 工具契约 | **完成（本地）** | T1 Schema + structuredContent；T2 公开错误 envelope；T3 归属回归已有测试覆盖 |
| M2 Token 与加密 | **完成（本地）** | T1 单次 token-invalid 恢复；T2 v2 envelope；T3 抖动+RT CAS |
| M3 Docker/YAML | **完成（本地）** | 严格 YAML storage/connected-account/keyring；healthcheck；Compose；部署文档 |
| M4 可观测与总验收 | **完成（本地）** | 事件日志、metrics、JWT runbook、ci-gate、技术验收矩阵 |
| M5 外部开放 | **锁定** | 需用户明确解锁 |

## 3. 不可妥协的全局规则

1. principal 只来自已验证 JWT 的 `iss + sub` 或独立旧实现认证链路；工具输入不能覆盖 tenant、user、employee、workspace、owner 或 issuer。
2. 每次账号型业务调用都重新联合校验 active Binding、Grant 和 Account；不能依赖之前调用过 `list_accounts`。
3. `account_id` 是 ConnectedAccount 唯一规范账号参数；外部 Seller ID 只能用于人工核对。
4. 成功结果必须严格匹配 `outputSchema`；失败必须 `isError=true`、文本 JSON 且没有 `structuredContent`。
5. Token、Secret、JWT、Cookie、code/state、完整 URL query、敏感正文不得进入 API、MCP、HTML、日志、指标或验收文档。
6. 只有 Amazon 官方明确规定的 Access Token 无效/过期条件可以触发强刷，并且最多原样重试一次。
7. PostgreSQL 是不可丢失状态的生产真相源；Redis 只用于短期 state/cache/lock/queue。
8. 数据库和密文格式采用 expand/contract；旧 key 在兼容窗口结束前不得删除。
9. 每个任务必须测试驱动、更新本计划、独立审查，评分达到 90/100 后才能本地提交。
10. 不推送远端；共享 CI、生产部署、Amazon Portal、外部卖家和审核提交均需用户另行确认。

## 4. 阶段与依赖

```text
M0 规格与证据基线
 ├── M1 MCP 工具契约
 ├── M2 Token 与加密密钥
 └── M3 Docker/YAML 生产配置
      └── M4 可观测性、轮换与技术总验收
           └── M5 外部开放【锁定，需用户解锁】
```

- M1、M2 的内部实现可在 M0 完成后并行，但各自独立提交；M2 的公开错误与 request ID 出口验收依赖 M1-T2。
- M2-T3 Refresh Token 原子轮换依赖 M2-T2 的版本化 crypto API、current key 和条件写模型。
- M3 可提前验证 Compose 安全基线，但最终 YAML keyring、readiness 和部署文档依赖 M2 配置模型冻结。
- request context 在 M1 建立、M2 贯穿 LWA/SP-API，M4 再统一事件字典、指标与告警。
- M4 技术总验收依赖 M1–M3 全部完成。
- M5 不因技术任务完成而自动解锁。
- 本地容器和隔离临时环境可以直接测试；共享 CI、共享预生产、外部告警系统、生产和 Amazon Portal 操作必须先取得用户确认。

---

## 5. M0 — 规格冻结与证据基线

### M0-T1：对齐设计规格模板

**文件**

- `docs/connected-account/connected-account-account-mcp-design-spec.md`
- `docs/connected-account/connected-account-acceptance-matrix.md`
- `amazon-sp-api-mcp/README.md`

**工作**

- 按 `assets/account-mcp-design-spec-template.md` 检查完整 11 章；
- 冻结 provider key、外部账号唯一键、`account_id`、凭据复用边界和 source of truth；
- 显式裁决 discovery 的 `independentOwnerAuthorization`：若为 `false`，记录同一 Seller 的全局排他所有权及冲突语义；若保持 `true`，新增数据迁移任务，将当前 `selling_partner_id` 全局主键改为 owner/issuer/Grant 一致的复合所有权模型，并迁移唯一约束、查询、OAuth callback 和回滚路径；在 capability、数据库和 runtime 一致前阻断 M0 出口；
- 明确 Unbind、ConnectedAccount Disconnect、旧实现 Disconnect、Credential Revoke、Physical Delete 的不同语义；
- 明确当前没有 Amazon 业务写工具，因此确认值、业务幂等、revision、operation unknown 为“不适用”；未来增加写工具必须另立专项设计；
- 将“key version 已设计但未实现”明确标为上线阻断。

**验收**

- discovery capability 每一项都有真实路由、实现和测试证据；
- 设计字段、数据库模型、工具目录和运行配置一致；
- 不包含真实 Secret、Token、数据库 URL 或生产账号数据。

### M0-T2：固定只读验收脚本（代码任务）

> 本任务会新增可执行脚本、测试和 npm 命令，是 M0 的首个产品代码任务，不只是文档复制。

**文件**

- 新增 `scripts/verify_connected-account_account_mcp.py`
- 新增脚本单元测试
- 根 `package.json`

**工作与验收**

- 从规范目录固定复制只读脚本并记录来源哈希；
- 保留拒绝 redirect、1 MiB 限制、超时和 `--json`；
- 无 JWT 检查 discovery/health；短期 JWT 检查 auth/check/accounts；
- 脚本不得调用授权、绑定、解绑、断开或业务写接口；
- 对非法 URL（含 userinfo/query/fragment）、301/302/307/308 redirect、超大响应、错误 JSON 和字段不一致建立测试；
- discovery/health 不发送 Authorization，`--json` stdout 只输出单个 JSON，诊断不得混入；
- 成功只代表只读基础契约通过，不能替代完整验收。

### M0-T3：建立版本化证据目录

**文件**

- 新增 `docs/acceptance/README.md`
- 后续每个 release 新增 `docs/acceptance/<release-id>.md`

**证据字段**

- commit/release、日期、环境类型；
- 测试命令和通过/跳过数；
- HTTP/MCP 安全摘要；
- 脱敏扫描；
- 独立评分、已知限制和阻断状态。

### M0-T4：固定协议兼容回归矩阵

**主要文件**

- `amazon-sp-api-mcp/test/http.test.ts`
- `amazon-sp-api-mcp/test/connected-account.test.ts`
- `amazon-sp-api-mcp/test/connected-account-accounts.test.ts`
- `amazon-oauth-service/server.test.mjs`

**逐项冻结**

- 所有固定 method/path、`protocolVersion=1.0`、camelCase 和 RFC3339 UTC；
- discovery capability 与真实路由及 principal 专属工具目录一致；
- `auth/check` 的 `employeeId/issuer/kid/expiresAt`；
- lookup 去重后最多 100 个且只返回当前 issuer 可见连接；
- Attempt 创建 201，并按 `issuer + employeeId + attemptId` 查询；
- remark 最多 80 个 Unicode 字符；
- Unbind 只影响当前 Employee，Disconnect 验证 Grant 权限且幂等；
- 401/404/409 固定语义；
- postMessage 只能包含 `type/attemptId/status`，targetOrigin 精确匹配。

**M0 出口**：设计、矩阵、脚本和固定协议回归独立评分 ≥90；身份和删除语义无歧义。

---

## 6. M1 — MCP 工具契约严格化

### M1-T1：全工具成功输出 Schema

**主要文件**

- `amazon-sp-api-mcp/src/tools.ts`
- `amazon-sp-api-mcp/src/safe-output.ts`
- 新增 `amazon-sp-api-mcp/src/tool-schemas.ts`
- `amazon-sp-api-mcp/test/tools.test.ts`
- `amazon-sp-api-mcp/test/safe-output.test.ts`

**范围**

为以下全部可见工具定义独立、紧凑的成功 `outputSchema`，并返回相同安全投影的文本 JSON 与 `structuredContent`：

- identity/accounts；
- marketplaces、business snapshot；
- orders search/get/items；
- inventory list/get-by-SKU；
- listings search/get；
- connection health和连接管理工具。

**契约要求**

- 列表统一使用 `items` 与必要分页字段；
- 不复用数据库或完整 SP-API DTO；
- 未知上游字段不能自动暴露；
- 输出不包含 tenant、workspace、Grant、Binding、credential 和审计元数据；
- annotations 完整声明 readOnly/destructive/idempotent/openWorld；
- ConnectedAccount 输入只接受 `account_id`，旧实现兼容输入只接受 `sellingPartnerId`。

**principal 专属工具目录（上线阻断边界）**

- ConnectedAccount Employee catalog 不注册 `amazon_create_authorization_url`、`amazon_create_renewal_url`、`amazon_list_connections`、`amazon_disconnect_connection` 等旧实现 legacy 连接管理工具；
- ConnectedAccount 账号生命周期只通过 `/connected-account/v1` Attempt/Binding/Unbind/Disconnect 管理，不能旁路 Grant/Binding；
- 旧实现 catalog 可在兼容窗口保留上述工具，但不得伪装成 ConnectedAccount principal；
- 对 ConnectedAccount、旧实现和受控 legacy principal 分别做 `tools/list` 快照测试；ConnectedAccount catalog 中不得出现 `sellingPartnerId` 参数或 legacy authorization/disconnect 工具。

**测试**

- `tools/list` 逐工具检查 input/output Schema 和 annotations；
- 每个成功 fixture 通过公开 Schema；
- 新增未知上游字段后投影保持封闭；
- 非所属账号逐工具拒绝且 LWA/SP-API 调用为 0；
- 所有失败都没有 `structuredContent`。

### M1-T2：统一 ConnectedAccount 错误契约

**主要文件**

- `src/errors.ts`、`src/tools.ts`、`src/http.ts`
- `test/errors.test.ts`、`test/tools.test.ts`、`test/http.test.ts`

**公开错误 envelope**

- `content[0].text` 序列化 `{ "error": { ... } }`，不得使用裸错误字段；
- `error` 内包含 `code`、`tool`、`message`、可选限长 `detail`、`http_status`、`request_id`、`next_action`；
- 参数错误的 `issues` 位于 `error.issues`；冻结字段长度、可选性并拒绝未知公开字段；
- `internal_error` 保留安全 message/next_action/request_id，但不包含内部诊断 detail。

**稳定 code**

- `invalid_tool_arguments`
- `unauthorized`
- `forbidden`
- `resource_not_found`
- `resource_changed`
- `conflict`
- `upstream_error`
- `timeout`
- `configuration_required`
- `internal_error`
- Provider 扩展 `rate_limited`：本地或 Amazon 429，附安全、受限的 retry-after；不得误称为鉴权失败或直接公开内部大写码。

内部 Amazon 大写错误码可保留，但必须通过适配层映射，不能直接成为 ConnectedAccount 公开契约。

**参数 issues**

一次返回全部独立问题，区分 `missing/unknown/wrong_type/out_of_range/invalid_enum/invalid_combination`；每项包含 `field/received/expected/fix`，敏感值只显示 `<provided>`、长度或来源类型。

**测试与验收**

- 工具失败 `isError=true`、文本 JSON、无 `structuredContent`；
- 未知工具和畸形 JSON-RPC 仍走协议级错误；
- `internal_error` 只返回 request ID，不返回异常、堆栈、路径、SQL 或上游 body；
- request ID 与 HTTP header 和日志一致；
- 不把 Amazon 401/403 一律映射为 Employee JWT 失效。

### M1-T3：账号归属回归矩阵

**主要文件**

- `src/identity.ts`、`src/postgres-connected-account-accounts.ts`、`src/tools.ts`
- 对应 identity/connected-account/postgres/tools 测试

**必须覆盖**

- 两个 issuer 的相同 `sub`；
- 同 issuer 两个 Employee；
- 一个 Employee 多账号；
- 伪造 tenant/user/employee/workspace/owner/issuer；
- 其他 Employee 的 `account_id`；
- unbound/disconnected/revoked/error 账号；
- 所有拒绝路径不调用 LWA/SP-API。

**M1 出口**：验收矩阵 Schema/Error 全部为“通过”；独立评分 ≥90，安全与隔离维度不得低于 23/25。

---

## 7. M2 — Token 恢复与凭据加密轮换

### M2-T1：Access Token 明确失效后的单次恢复

**主要文件**

- `src/sp-api-client.ts`
- `src/lwa.ts`
- `src/redis-coordinator.ts`
- 对应测试

**先决条件**

实施时必须查阅当时最新 Amazon SP-API 官方文档，冻结可触发恢复的明确错误条件；不能猜测或把所有 401/403 当 Token 失效。

**算法**

1. 第一次收到明确 token-invalid；
2. 检查共享缓存是否已有不同于被拒 Token 的新值；
3. 有则复用；否则在 Redis lock 内强制刷新；
4. 使用新 Token 原样重试一次；
5. 第二次失败立即停止。

**现有强刷旁路整改（上线 blocker）**

- 删除或改造 `amazon_connection_health` 当前无条件 `forceTokenRefresh=true` 行为；健康检查优先复用有效 Token，不得因普通诊断产生 LWA exchange；
- 禁止任何普通 MCP 工具通过输入或固定逻辑直接触发强刷；
- 除 token-invalid 恢复适配层外，静态搜索与动态测试必须证明 `forceTokenRefresh=true` 调用数为 0；
- 如保留管理员强刷诊断能力，必须使用独立管理员认证链路、不可出现在 ConnectedAccount catalog，并单独审计。

**负向测试**

403 权限不足、404、429、5xx、网络错误、timeout、输入错误均不得触发强刷。两实例同时收到失效错误只能产生一次有效 LWA exchange。日志不得包含被拒 Token 或新 Token。

### M2-T2：版本化 AES-GCM envelope

**主要文件**

- `amazon-oauth-service/server.mjs`
- `amazon-sp-api-mcp/src/token-store.ts`
- `amazon-sp-api-mcp/src/postgres-token-store.ts`
- 新增共享 crypto 模块或等价单一实现
- `migrate-storage.mjs`
- 新增 `rotate-encryption-key.mjs`
- OAuth/MCP 存储测试

**目标格式**

```text
version | key_id | algorithm | nonce/iv | ciphertext | authentication_tag
```

- 当前无 `version/key_id` 的结构正式命名为 `legacy-unversioned`，只在迁移窗口识别；
- 新格式使用明确版本（建议 `version=2`）；缺失 version 只有在字段集合完整匹配 legacy shape 时才可兼容；
- 一旦存在 version，未知值必须 fail closed；字段集合、Base64 编码、nonce/tag 长度必须严格校验；
- AES-GCM AAD 绑定 `version/key_id/provider/credential ID`，防止密文跨记录替换。

**配置模型**

- 明确当前写 key ID；
- keyring 可读取有限的旧 key；
- key ID 不包含 Secret；
- readiness 只返回 ready/error，不返回 key 长度、前缀、后缀或哈希。

**迁移顺序**

1. expand：新增 `legacy-unversioned` + versioned v2 双读；
2. 新写只使用当前 key 的 v2；
3. dry-run 只统计版本和无法解密数量，不输出密文；
4. 事务批量重加密，条件更新或 `FOR UPDATE SKIP LOCKED` 防止覆盖并发 OAuth 更新；
5. 验证全量后进入旧 key 退役等待期；
6. 完成备份、SHA-256、恢复和旧版本兼容验证后才允许移除旧 key。

**测试**

- legacy-unversioned/v2 正常读取；未知 version/key_id fail closed；
- current key 缺失、key ID 冲突和旧 decrypt key 缺失时启动/readiness 行为确定；
- nonce/tag/ciphertext/AAD 篡改拒绝；
- 双实例迁移、并发 OAuth 更新、中断恢复；
- 新旧应用兼容窗口；
- 日志、错误和 dry-run 无 Token、密文和 key。

### M2-T3：刷新抖动与 Refresh Token 原子轮换

**主要文件**

- `amazon-sp-api-mcp/src/token-store.ts`
- `amazon-sp-api-mcp/src/postgres-token-store.ts`
- `amazon-sp-api-mcp/src/lwa.ts`
- `amazon-oauth-service/server.mjs`
- 对应 OAuth、LWA 和 PostgreSQL 测试

**可写存储契约**

- Refresh Token 读取同时取得 credential revision/generation；
- 增加 compare-and-set 或事务行锁的加密更新接口，并联合校验 tenant、seller、credential active 状态；
- OAuth service 与 MCP 共享同一 crypto/envelope 实现，或具备双向交叉兼容测试；
- OAuth callback 与后台刷新并发时，旧刷新结果不得覆盖新授权凭据；
- 两实例产生冲突更新时只能有一个条件写成功，失败方重新读取，不盲目覆盖。

**刷新顺序**

- 以服务端接收时间计算过期点并加入有界随机抖动；
- Amazon 若返回新 Refresh Token，先原子加密持久化；持久化失败时保留旧 Token，不发布新 Access Token；
- 持久化成功后才写共享 Access Token 缓存并视为刷新成功；
- 刷新失败有界退避，禁止紧密循环。

**M2 出口**：Token 明确失效与不得刷新路径通过；密文轮换阻断项变为“通过”；预生产轮换和恢复演练成功；独立评分 ≥90。

---

## 8. M3 — Docker/YAML 生产配置

### M3-T1：扩展严格 YAML 模型

**主要文件**

- `config.example.yaml`
- `docker/config-loader.mjs`
- `docker/config-loader.test.mjs`
- `docker/docker-entrypoint.mjs`
- `docker/healthcheck.mjs`
- `docker-compose.yml`
- 根 `package.json`
- `docs/operations/DEPLOYMENT.md`（主部署文档；`DOCKER_DEPLOYMENT.md` 为兼容入口）

**冻结的 YAML schema（不是建议项）**

- `storage.postgres`：`url` 与 `urlFile` 互斥；`schema`、pool min/max/timeout 有界且有默认值；
- `storage.redis`：`url` 与 `urlFile` 互斥；namespace 非空、长度受限且禁止空白/控制字符；
- `connected-account.enabled`、`audience`、`allowedOrigins`、`jwtKeys[]`；每个 JWT key 固定包含 `kid/issuer/secretFile`，kid 唯一；
- `amazon.credentialKeys.currentKeyId` 与 `keys[]`；current key 必须存在于唯一 keyring，Secret 通过私有 YAML 或只读 secret-file 二选一；
- `mcp.identityHealthUrl` 可选，配置后必须安全校验；
- 明确每个字段的类型、必填条件、默认值、范围、互斥关系和向 OAuth/MCP 子进程的环境映射；
- 旧单 key YAML 只在有期限的兼容窗口映射为 `legacy-unversioned` decrypt key；不得静默当作新 current key。

**验证规则**

- 默认 `connected-account.enabled=false`；
- 开启时强制 PostgreSQL、Redis、audience、至少一个 JWT key 和精确 allowed origins；
- loader 对 JWT/加密 Secret 强制解码后至少 32 字节，并拒绝空值、全零、全相同字节、明显短周期重复模式和已知 placeholder；运维必须由 CSPRNG/Secret Manager 生成，验收只记录生成机制而不声称 loader 能证明熵或记录 Secret；
- 生产 origin 必须 HTTPS，禁止 `*`；
- 未知字段、重复 key、不完整 keyring、冲突 key ID 均拒绝；
- 错误只显示字段路径，不显示配置值；
- 私有 YAML 继续只读挂载、权限 0600 且不进入 Git/镜像。

### M3-T2：生产模式 readiness 和 Compose 验证

**Compose 与 healthcheck 固定要求**

- production mode readiness 必须包含 PostgreSQL、Redis、OAuth、加密 keyring 和 identity service；liveness 只反映进程可服务，不因可恢复的外部依赖故障退出；
- 文件模式仅作为本地/兼容 beta，文档不得再称其为生产唯一真相源；
- Docker 不强制内置 PostgreSQL/Redis，但必须安全支持外部/宿主机服务；Compose 示例不得写入真实凭据，外部依赖 URL 只从私有 YAML/secret-file 读取；
- Compose `healthcheck` 必须执行容器内 `node /app/docker/healthcheck.mjs`，配置明确且有界的 `interval/timeout/retries/start_period`，不得依赖镜像中未安装的 curl/wget；
- healthcheck 同时要求 OAuth `/healthz`、MCP `/healthz` 和 MCP `/readyz` 成功；任一路径非 2xx、超时或 JSON 契约错误均为 unhealthy；
- 构建基于 commit 的唯一镜像 tag，先执行 `npm run test:docker-image -- amazon-sp-api:<tag>`，再用完全相同 tag 启动 Compose，禁止 `latest` 或旧缓存作为验收证据；
- 使用 `docker compose up -d --wait --wait-timeout <bounded-seconds>` 或等价有界轮询等待 `healthy`；超时必须输出脱敏后的 compose 状态和最近日志并清理测试资源；
- 健康后从宿主机分别验证 OAuth `/healthz`、MCP `/healthz`、`/readyz` 的状态码与安全 JSON，不以容器状态单独代替端点验收；
- 分别故障注入 PostgreSQL、Redis、identity service 和错误 keyring：`/readyz` 必须在有界时间内变为 503，OAuth/MCP liveness 仍按既定语义响应；依赖恢复后 readiness 必须自动恢复；
- 测试覆盖首次启动、重启、只读根文件系统、非 root UID/GID 10001、私有 YAML 只读挂载和宿主机持久化目录权限；所有测试容器、网络和临时 stub 最终清理。

### M3-T3：部署、备份和回滚文档

分别描述：

- 本地文件兼容模式；
- PostgreSQL/Redis production 模式；
- schema expand/contract；
- 数据库备份、keyring 独立备份与恢复；
- JWT 和加密 key 轮换；
- `CONNECTED_ACCOUNT_ENABLED=false` 技术回滚；
- 旧版本无法理解新密文时采用蓝绿/双读，禁止破坏性 down migration。

**M3 出口**：同一份私有 YAML 能表达完整生产架构；默认不开启 ConnectedAccount；真实容器与依赖健康验证通过；独立评分 ≥90。

---

## 9. M4 — 可观测性、轮换与技术总验收

> 本阶段只负责技术发布门禁，不等同于此前暂缓的外部开放阶段。

### M4-T1：集中式安全事件日志

**主要文件**

- `src/logger.ts`、`src/http.ts`、`src/lwa.ts`、`src/sp-api-client.ts`
- `amazon-oauth-service/server.mjs`
- 对应日志测试

**要求**

- 固定事件字典和逐事件字段白名单，不允许任意对象、异常对象、HTTP headers 或上游响应透传；logger 对未知事件、未知字段和错误字段类型 fail closed 或丢弃并计数；
- 所有事件仅允许公共字段 `timestamp/event/severity/service/request_id/result/duration_ms/error_code`；`duration_ms` 有界且只接收非负数，`error_code` 必须来自稳定枚举；
- `mcp.tool.completed` 额外只允许 `tool/actor_type/issuer_alias`；issuer 只能使用运维配置的低基数别名，不记录原始 issuer、employee、seller 或 account ID；
- `oauth.attempt.*` 额外只允许随机不可反查的 `attempt_ref/status/reason_code`；`binding/unbind/disconnect` 只允许动作、结果和不可跨系统关联的内部安全摘要；
- `lwa.refresh.*`、`sp_api.request.*` 只允许 provider/operation 的受控枚举、attempt/result/duration/error class，不允许 URL、method 参数、body 或供应商原始错误；
- readiness/config/rotation 事件只允许 dependency、状态、配置版本和 key ID；key ID 必须先通过字符集/长度校验，不能记录 key 材料、密文统计样本或 revision；
- request ID 贯穿 HTTP、MCP tools/call、LWA、SP-API、OAuth callback；外部传入 request ID 必须验证格式/长度，不合格则重新生成；
- 每次工具调用记录 tool/result/duration/request_id/安全 actor 类型/稳定错误码；OAuth 记录 Attempt created/completed/expired、state rejected/replayed、callback、Binding、Unbind、Disconnect、Token recovery/rotation；
- 禁止 Authorization、JWT、Token、Secret、Cookie、code/state、query、正文、Base64、revision、幂等键、确认值和成功响应；禁止把任意字符串塞入 message/detail 旁路白名单。

测试必须逐事件断言允许字段，向 logger 注入未知字段、嵌套对象、超长值和异常对象并确认不落盘。使用唯一 canary 注入全部敏感入口并扫描 stdout/stderr、结构化日志、MCP、HTTP、HTML，命中必须为 0。

### M4-T2：低基数指标与告警

**实现与暴露边界**

- 采用 Prometheus 文本格式或等价 exporter；固定内部端点 `/internal/metrics`，默认只监听容器内/管理地址，不加入公开 discovery，不允许 Employee JWT 访问；
- 若必须经过反向代理，使用独立运维认证和网络 allowlist；无认证公网暴露为上线 blocker；黑盒测试要求 public origin 请求 `/internal/metrics` 返回 403/404，而受控管理网络可抓取，并检查现有 Nginx/通用 location 不会意外代理该路径；
- OAuth 与 MCP 是同容器的独立进程：各进程使用独立 registry/内部端口，由受限 exporter 聚合，或由 sidecar/采集器分别抓取；禁止两个进程写同一 metrics 文件，聚合失败不得让业务进程退出；
- 指标统一使用 `amazon_connected-account_` 前缀、base unit 后缀（`_seconds/_bytes/_total`）和有界 label 枚举；文档冻结每个指标的 type、help、label 集合和 owner。

**最小指标**

- Counter：MCP 鉴权/Scope/协议失败、工具结果错误码；Attempt 成功/失败/超时、state replay、Origin 拒绝；Binding/Unbind/Disconnect；LWA 正常/强制刷新/失败；SP-API 429/5xx/timeout；
- Histogram：MCP tool 和 SP-API 延迟使用预先冻结的秒级 buckets，以 histogram_quantile 计算 P95/P99；LWA 分布式锁等待单独 histogram；
- Gauge：PostgreSQL/Redis/identity readiness（0/1）、连接池 active/idle/waiting、待迁移凭据数量；key version 只用受控 `key_id` label 或按 current/legacy/unknown 分类，key ID 数量有配置上限；
- Queue/worker 指标只有实际引入异步队列时才启用，否则在验收矩阵逐行标记“不适用（当前无 Queue/Worker，设计禁止虚构指标）”。

label 只允许 tool、result、稳定 error_code、provider operation 枚举、dependency、actor_type 和受控 key class/kid；禁止原始 issuer、employee、seller、account、attempt、request ID、URL 或任意上游错误。测试枚举 label 基数上限，注入未知/超长 label 必须拒绝或归一为 `unknown`。

告警规则和 runbook 必须冻结 PromQL/等价表达式、窗口、阈值、for 时长、严重级别、责任人、处置、静默边界和恢复验证；至少实际触发并恢复鉴权失败率、Attempt 失败、LWA 刷新失败、SP-API 429、readiness 和连接池耗尽告警。告警 annotation 只能包含 runbook 链接、受控服务/错误码，不包含敏感或高基数字段。

### M4-T3：JWT 双 key 轮换演练

顺序固定：

1. Provider 双信任旧、新 key，并记录最后一次允许旧 key 签发 JWT 的时间 `T_old_last_issue`；
2. ConnectedAccount 切换新 `kid/secret`，确认此后不再使用旧 key 签发；
3. 验证新 JWT；
4. 从 `T_old_last_issue` 起等待至少 JWT 最大寿命 5 分钟 + 允许时钟偏差 30 秒；部署传播时间不能计入或缩短该窗口；
5. 使用轮换前最后签发的旧 JWT 确认已过期，并确认新 JWT 仍成功；
6. 删除旧 key；
7. 旧 kid 返回 401 且不泄露细节；若无法证明 `T_old_last_issue`，不得删除旧 key。

演练记录只保存 key ID、配置版本、`T_old_last_issue`、删除时间和验证结果，不保存 Secret 或 JWT。

### M4-T4：CI 与发布门禁

CI/等价流水线必须使用 Node 22，执行：

- 根目录与两个子项目 `npm ci`；
- 全部单元测试、typecheck、build；
- PostgreSQL/Redis 集成测试；
- Docker config、build、唯一 tag runtime import；
- 只读验收脚本测试；
- 敏感 canary 扫描；
- schema/密文迁移前后兼容测试。

创建或修改共享 CI 属于外部可见配置，实施前需用户确认。

### M4-T5：技术总验收

以规范 `assets/acceptance-matrix.md` 为唯一行清单，复制到当前 release 证据文件后逐行裁决；不得只用阶段摘要替代原矩阵。每行必须填写：规范原文、适用性、自动化测试/请求响应摘要/安全日志证据链接、负责人、验证日期和结论。

验收结论只允许：`通过`、`不适用（有设计依据）`、`阻断`，不得保留“待验证”或以“部分通过”作为上线结论。`不适用` 必须同时给出设计规格章节和证明功能不存在的代码/catalog/路由证据，独立 reviewer 可驳回；没有证据一律为阻断。

**当前必须预先裁决的规范行**

- Mutation 精确确认值、Idempotency 两行、Concurrency revision/ETag、Timeout operation unknown：仅对 **ConnectedAccount principal catalog** 因不存在 Amazon 业务写工具而逐行标记“不适用”，引用 M0 设计结论和 ConnectedAccount `tools/list` 快照；不得把该结论扩大为整个仓库无写工具；未来向 ConnectedAccount 增加任何业务写工具即自动恢复为阻断验收项；
- 旧实现/legacy 兼容 catalog 的 `amazon_disconnect_connection` 仍属于 destructive 管理工具，必须独立回归确认值、annotations、tenant/credential 归属、重复调用幂等语义及不误删其他 Employee/Grant；authorization/renewal URL 工具也必须验证 principal 隔离与安全输出；
- Queue Worker 重试：当前无异步 Queue/Worker，标记“不适用”并附进程/依赖/代码搜索证据；一旦引入队列即必须覆盖上限、退避、dead-letter/unknown；
- Network URL/文件/Webhook：分别裁决；只读验收脚本的 URL 为“适用”并提供协议、userinfo/query/fragment、redirect、timeout、1 MiB 测试；若产品无文件上传/Webhook，则对应子项分别标记“不适用”，不能合并掩盖；
- Deploy HTTPS/反向代理：容器不内置代理不代表不适用；必须以 public origin、trusted proxy/forwarded header 策略和部署者 TLS 责任边界证据裁决，生产端到端 HTTPS 未验证则阻断 M5；
- Observability 中 Queue 维度按上述 Queue 裁决，其余授权、Token、MCP、上游指标与告警必须通过。

**逐行证据至少覆盖**

1. discovery/health 与 runtime tool mapping；
2. JWT 正反例、最大寿命、四类 Scope；
3. 两 issuer、两 Employee、多账号及伪造 principal；
4. Attempt/state/Binding/Unbind/Disconnect、callback Origin/安全头；
5. MCP transport、identity/accounts、全工具 Schema 和错误；
6. Token 正常刷新、明确失效强刷、不得刷新、多实例与 Refresh Token 原子轮换；
7. Secret 输出边界、加密 key 与 JWT key 轮换；
8. 日志、指标、告警；
9. network、HTTPS、readiness、迁移、备份、恢复和回滚；
10. 规范只读脚本。

最后由自动检查拒绝空证据、未知状态和仍为“待验证”的行，并生成通过/不适用/阻断计数。技术总验收独立评分 ≥95，阻断项为 0，才允许请求用户决定是否解锁外部开放阶段。

---

## 10. M5 — 外部开放与 Amazon 审核【LOCKED】

只有用户明确说“解锁 M5/外部开放”后才能执行。

### M5-T1：Amazon 沙盒 E2E

授权 → Attempt → Binding → list_accounts → 只读 Orders/Inventory/Listings → Unbind/Disconnect → 再授权；补无效 state、重放、跨员工冲突证据。

### M5-T2：审核包与组织事实

补齐：法定主体、品牌网站、隐私政策、服务条款、数据删除 URL、安全邮箱、保留期限、共享方/子处理者、审核录屏和三方签署。审核材料必须反映 PostgreSQL/Redis、ConnectedAccount Grant/Binding 和实际 Disconnect 语义。

### M5-T3：legacy 最终下线

完成调用方清单、观察窗口、移除生产 legacy Secret、删除 legacy 分支和发布说明。不得恢复无 tenant 的共享 Token。

### M5-T4：允许列表与容量策略

全局 seller allowlist 只作为封禁/灰度层，主授权仍由 Binding + Grant + Credential 决定；完成 snapshot/listings 成本预算、限流和压测。

### M5-T5：外部卖家 pilot 与渐进放量

应用批准后，从内部 Employee、指定 workspace、1–5 个卖家、10%、50% 到全量；每级必须满足错误率、延迟、429、刷新、state replay、泄密和越权阈值，并有在线 rollback owner。

**M5 最终门禁**

- Amazon 生产应用审核批准；
- 政策与组织联系人有效；
- legacy 下线；
- 外部卖家闭环通过；
- 告警、值班、备份、恢复、轮换均已演练；
- 产品、安全/运维、法务签署；
- 最终独立评分 ≥95，阻断项 0。

## 11. 每任务统一执行流程

1. 从计划中选择一个最小任务，不跨任务扩大范围；
2. 先写失败测试或可复现验证；
3. 完成最小实现；
4. 运行相关单元、集成、typecheck、build 和 Docker 门禁；
5. 更新本计划和验收矩阵，记录安全摘要；
6. 启动未参与实现的独立 reviewer；
7. reviewer 按 100 分评分并列 blocker/major/minor；
8. 低于 90 或存在 blocker 时整改并由同一 reviewer 复审；
9. 达标后仅提交本地 Git；不得 push；
10. 阶段末再做跨任务综合审查。

## 12. 评分标准

| 维度 | 分值 |
|---|---:|
| 正确性与协议兼容 | 25 |
| 身份、隔离与安全 | 25 |
| 测试与真实证据 | 20 |
| 回滚与数据兼容 | 10 |
| 可观测与运维 | 10 |
| 文档与可维护性 | 10 |

门槛：单任务 ≥90；安全与隔离 ≥23/25；测试与证据 ≥18/20；技术总验收和外部开放 ≥95。任何 blocker 都直接不通过。

## 13. 自动阻断条件

以下任一项存在时，`CONNECTED_ACCOUNT_ENABLED` 必须保持 `false`：

- 可通过 tenant/user/employee/owner/connection/account 输入越权；
- JWT alg/kid/issuer/audience/time/Scope 校验不完整；
- Token、Secret、code/state、敏感正文进入输出、页面、日志或指标；
- state 可复用、跨 Employee 消费或由浏览器参数决定归属；
- 非所属 `account_id` 在任一业务工具可用；
- Unbind/Disconnect 误删无关凭据；
- 错误进入成功 `structuredContent`；
- 多实例 Token 刷新或 Attempt/Binding 缺锁与数据库唯一约束；
- 普通 403/5xx/网络错误触发刷新，或明确失效形成刷新循环；
- 密文没有 version/key_id，或旧 key 无法在轮换期解密；
- discovery capability/runtime 与实际工具不一致；
- 生产入口不是 HTTPS 或 callback 使用 `*`；
- 关键验收只有代码审阅、没有可执行证据；
- 独立审查未达门槛。

## 14. 推荐实施顺序

1. **M0-T1～T4**：先消除文档、矩阵和证据歧义，并冻结协议回归；
2. **M1-T1**：全工具 output Schema/structuredContent；
3. **M1-T2～T3**：错误契约和归属总回归；
4. **M2-T1**：Amazon token-invalid 单次恢复；
5. **M2-T2～T3**：版本化密文与轮换；
6. **M3-T1～T3**：完整 Docker/YAML production 模式；
7. **M4-T1～T5**：日志、指标、轮换、CI 和技术总验收；
8. 等待用户决定是否解锁 **M5**。

第一项仓库代码任务为 **M0-T2 固定只读验收脚本**；第一项 MCP 产品契约实现任务为 **M1-T1 全工具成功输出 Schema**；第一项安全阻断实现任务为 **M2-T2 版本化凭据加密 envelope**。三者应按依赖分开提交和审查。
