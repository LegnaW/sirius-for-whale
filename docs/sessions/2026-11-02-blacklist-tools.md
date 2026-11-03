# 2026-11-02 会话：Sirius 主会话工具黑名单

## Plan + Spec（用户已确认）

主会话从 `SIRIUS_ALLOW` 白名单切换为 `SIRIUS_DENY` 黑名单。默认放行所有已注册工具，只禁用 `bash`、`pwsh`、`plugin_manager`，保留本机执行和插件管理边界。`skill`、`web_fetch`、`web_search`、Soul 检索、文件、协作及后续新工具不再逐个加白名单。

子代理继续使用 `SUB_TOOLS` 白名单，非 Sirius 会话继续隐藏除 `sirius_status` 外的游戏工具，身体所有权不变。黑名单也先用 `ctx.tools.get()` 过滤宿主不认识的名字，诊断改为 `mode/denied/dropped`，避免未知工具导致 `restrict` 抛错。

验收：黑名单包含三项危险工具，不包含 skill/Web/Soul/文件/游戏工具；子代理策略不变；README 与诊断同步；完整 `npm test`。真实 DSH 重启后检查 skill、Web 和 Soul 工具可见，三项黑名单不可见。

## 收尾日志

### 文件改动

- `src/plugin.mjs`：`SIRIUS_ALLOW` 改为 `SIRIUS_DENY=['bash','pwsh','plugin_manager']`；主会话默认放行并过滤未知禁用项，诊断改为 `mode/denied/dropped`；子代理白名单保持不变。
- `test/policy.test.mjs`：固定三项黑名单，验证全部游戏工具、skill、Web、Soul、文件和协作工具均未被禁用。
- `README.md`、`docs/PROGRESS.md`：同步黑名单、诊断字段和真机验证要求。

### 自动验证

- 完整 `npm test`：**223 passed / 0 failed**。测试数比前一轮少 2，是因为旧白名单的 4 项断言合并成黑名单的 2 项，子代理测试未减少。

### 部署与未完成

- 需要重启 DSH，建议新建 Sirius 会话验证 skill、Web、Soul 检索可见，三项黑名单不可见。
- 本轮没有改桥端协议或 jar，不需要因此单独部署桥。
