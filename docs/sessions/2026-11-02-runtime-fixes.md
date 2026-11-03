# 2026-11-02 会话：周期任务与 damage 默认拉取修复

## Plan + Spec（用户已确认修复前三项中的插件侧两项）

### 周期任务

现状：`plugin.mjs` 的 20 秒 ticker 未等待异步 `link.status()`，Promise 上没有 `online` 字段，导致周期逻辑总走离线分支，自主触发、能力重探、身份刷新和订阅补偿被跳过。

方案：把单次维护 tick 提取为可注入依赖的 `createBridgeMaintenanceTick`，显式等待状态；保留原有在线/离线状态清理语义。ticker 捕获单次失败，避免产生未处理 Promise rejection。

验收：异步在线状态能触发能力探测、订阅确保、身份刷新和自主 tick；离线仍清空连接级缓存；现有 212 项测试与新增回归全部通过。

### damage 默认拉取

现状：桥连接和 Watchdog 已处理 `damage`，`sirius_events` 的默认过滤列表却没有它。

方案：默认拉取列表及工具说明加入 `damage`。不加入 `screenshot`，避免默认结果携带大体积图片。

验收：不传 `types` 时订阅并返回 damage；现有事件游标、limit 与 wait 行为不变。

## 收尾日志

### 文件改动

- `src/maintenance.mjs`：新增可测试的单次周期维护逻辑，显式等待异步状态，保留在线维护与离线缓存清理。
- `src/plugin.mjs`：接入维护 tick，避免周期任务重叠并记录单次失败；工具数量注释同步为 27。
- `src/tools.mjs`：默认 `sirius_events` 订阅和过滤加入 `damage`，不包含 `screenshot`；工具说明同步。
- `test/maintenance.test.mjs`：新增在线、离线、重连未订阅三项回归。
- `test/tools.test.mjs`：新增默认 damage 且排除 screenshot 的回归；工具数量名称同步。
- `test/policy.test.mjs`：工具数量名称同步为 27。

### 自动验证

- 相关测试：`node --test test/maintenance.test.mjs test/tools.test.mjs`，**68 passed / 0 failed**。
- 完整 `npm test`：**216 passed / 0 failed**。

### 部署与未完成

- 插件代码变化需要重启 DSH；本轮未重启，因此真实周期维护、自主节律和 damage 默认拉取仍待真机验收。
- 桥端配套修复位于独立 `sirius-bridge`，其新 jar 也需部署并重启游戏。
