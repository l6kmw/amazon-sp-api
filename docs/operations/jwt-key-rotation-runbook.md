# JWT 双 key 轮换演练 Runbook

> 记录只保存 key ID、配置版本、`T_old_last_issue`、删除时间与验证结果。  
> **禁止**保存 Secret、JWT 原文或员工标识。

## 固定顺序

1. **Provider 双信任**  
   在 `connected-account.jwtKeys`（或 `CONNECTED_ACCOUNT_JWT_KEYS`）同时配置旧 `kid` 与新 `kid`。  
   记录最后一次允许使用旧 key 签发 JWT 的时间：`T_old_last_issue`（UTC）。

2. **ConnectedAccount 只签发新 key**  
   确认 IdP/ConnectedAccount 配置切换为新 `kid/secret`，之后不再用旧 key 签发。

3. **验证新 JWT**  
   使用新 JWT 调用 `/connected-account/v1/auth/check` 与 MCP `tools/list`，预期 200。

4. **等待窗口**  
   从 `T_old_last_issue` 起至少等待：  
   `JWT 最大寿命 5 分钟 + 时钟偏差 30 秒 = 330 秒`。  
   **不得**用部署传播时间缩短该窗口。

5. **确认旧 JWT 已失效、新 JWT 仍成功**  
   - 轮换前最后签发的旧 JWT → `auth/check` 401  
   - 新 JWT → 仍 200  

6. **删除旧 key**  
   仅在步骤 5 通过且 `T_old_last_issue` 可证明时删除旧 `kid`。

7. **旧 kid 401 且不泄露细节**  
   使用旧 kid 的 JWT → 401，响应体无 Secret/issuer 内部诊断。

## 本地自动化证据

- 双 key 同时信任：`test/connected-account.test.ts`（verifier 接受配置表中任一 kid）  
- 未知 kid / 错误签名 → 401：同文件  
- 配置层双 key：Docker loader `connected-account.jwtKeys[]` kid 唯一、secret ≥32 字节  

## 演练记录模板

| 字段 | 值 |
|---|---|
| 配置版本 / commit | |
| 旧 kid | |
| 新 kid | |
| `T_old_last_issue` (UTC) | |
| 等待秒数 | ≥330 |
| 新 JWT auth/check | |
| 旧 JWT 过期验证 | |
| 删除旧 key 时间 (UTC) | |
| 删除后旧 kid 401 | |
| 操作人 | |
