# 2026-11-03 会话：伤害监测迁移到内置插件

## Plan + Spec（用户已确认）

将旧 Watchdog 的 `damage` 监测完整迁移到 `core.damage_watch`，旧硬编码分支停用，其它聊天和危险事件监测不变。

### 行为对齐

- 内置插件默认启用；`watchdog.wakeOn.damage=false` 改为控制它的初始启用状态。
- 沿用 `damageCooldownMs=30000`、`observeWindowMs=1500`、`maxWakePerMinute=6`，通过 manifest 默认 args 传入脚本。
- 所有实际扣血进入伤害判断；冷却只抑制唤醒，不影响 bridge 原始事件记录。
- 保留攻击者、直接伤害实体、伤害类型的区分；缺失数值显示 `?`，可计算时补算损失，未知来源不猜测。
- 观察窗口内合并，单条最多五项，插件自身执行每分钟强唤醒额度；通知仍统一经过 `deliverWake` 并附近期聊天。
- 旧 Watchdog 在宿主接线处强制 `wakeOn.damage=false`，防止双链唤醒；类本身及其它事件行为不改。

### 验收

- 单元测试覆盖默认启用、来源与缺失字段、合并、冷却边界、停用和旧版其它事件回归。
- 运行 `npm test` 与两仓 `git diff --check`。
- 按 `local.md` 重启 DSH，使用现有 Minecraft 客户端和单个 Sirius 会话做真实伤害验收；创造模式不能作为扣血样本，测试后恢复血量、模式和插件状态。

## 实施与自动验证

- `core.damage_watch` 默认启用，manifest args 接收旧 `watchdog` 的伤害冷却、观察窗口和强唤醒额度；脚本内完成冷却、合并、限流、完整来源格式与缺失字段降级。
- PluginManager 接收伤害配置；宿主把旧 Watchdog 的 `wakeOn.damage` 强制设为 false，只屏蔽旧 damage 分支，其它事件保持原样。
- 新增来源/未知字段、冷却边界、观察窗口合并和默认恢复回归；恢复测试改为查找目标用户插件，不再假定默认伤害插件不存在。
- 完整 `npm test`：**255 passed / 0 failed**；两仓 `git diff --check` 通过。
- DSH 已按 `local.md` 使用 `--no-open` 重启。

## 完整 DSH / Minecraft 真机验收

- 当前配置含有 `wakeOn.damage=false`，所以首次列表显示新插件 enabled=false，这是继承旧配置而非默认值失效。本轮在 `sirius_init` 后显式 enable，run 为 running，订阅 types=[damage]，队列无丢失。
- 客户端一度不在运行，按 PCL 参数重启。初次误入单人测试存档后未做世界修改并退出；随后按 local.md 进入 localhost:25565 的“神人服务器来的”，先完成 auth 登录，从观察者恢复生存，再执行测试。服务器进程与 jar 未操作。
- 生存模式连续两次合法 `/damage` 均造成 20→19.5、0.5 点 minecraft:generic 真实伤害，原始事件 seq 6/11 均保留，间隔约 5.1 秒；只产生一次 `core.damage_watch` 唤醒，旧 Watchdog 未重复通知。
- 通知包含血量、损失及“来源：类型 minecraft:generic”。测试后 instant_health 恢复 HP20/20，effects 为空，仍 survival，坐标不变；替代旧监测的 core.damage_watch 保持 running。
- DSH、客户端及「伤害插件迁移验收」浏览器标签组保持运行。临时 WebBridge 请求文件已删除。
