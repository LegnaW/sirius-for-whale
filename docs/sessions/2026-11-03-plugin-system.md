# 2026-11-03 会话：插件注册、生命周期、编排与优先级

## Plan + Spec（用户已确认）

在只读 ScriptRuntime 之上增加完整插件层，不推翻 Worker/事件/run 底座。

### 定义与所有权

- 内置插件 `core.*` 随包注册：可启停、查看、配置和运行，不可通过 Agent 修改或删除。
- 用户插件 `user.*`：可创建、启停、更新版本、删除和运行；更新/删除先终止旧实例。
- 插件定义（代码/manifest/enabled）与运行实例（run id/status/log/checkpoint）分离；enabled 是期望状态，active 是实际 Worker 状态。
- 可选 JSON store 保存用户插件与 enabled 状态，使用宿主文件 IO 和原子替换；脚本仍无文件能力。

### 生命周期

- once：启用/调用执行一次，终局 completed/failed/cancelled，可再次运行。
- task：条件、超时、抢占或取消后结束。
- service：持续监听；可配置 persistent 自动重启，有限次退避，手动停用才清除期望状态。非 persistent service 达到条件后自动关闭。
- 启用幂等，同一插件默认单实例；停止使 incarnation 失效。状态另含 preempted，不能将被抢占写成完成。
- `sirius_plugin` 提供 list/get/create/update/delete/enable/disable/run/status/logs。

### 嵌套编排（本轮新增用户要求）

- 插件可通过 `ctx.plugins.start/wait/stop` 调用其他**已注册**插件，可组合复杂流程；不提供任意代码递归 eval。
- 调用记录 parent/root/depth/plugin stack，最深 8 层；A→B→A 等循环调用拒绝。父实例结束会停止其子实例。
- 子插件优先级不能帮助低优先级父插件提权：effective priority 取父/子较低值。用户插件优先级上限 80，内置高优先级最高 90，系统 stop/init 永远更高。
- start 不改变子插件 enabled；enable/disable 管理期望状态。嵌套 stop 只允许同一 root 调用链。

### 动作调度与通知

- 写动作只向注册插件开放；原 `sirius_script` 临时只读脚本保持只读。
- 开放精确动作：dig/place/use/useItem/entity.use/entity.attack/inventory.select/container.*/baritone.goto/follow/stop/settings/tunnel/chat.send；原始键鼠 input.* 不作为常规脚本能力。
- ActionScheduler 按 movement/world_edit/interaction/inventory/combat 仲裁。低优先级冲突等待，高优先级抢占并停止旧 run，记录 preempted；租约在 run 结束释放，等待可取消。
- `ctx.notify` 通过宿主统一 deliverWake，按插件做短间隔去重，不能直接 agent.steer。
- run/outcome 分离；抢占、超时、取消不宣称世界效果已撤销。

### 初始内置插件

- `core.open_block`：指定坐标直接 use；否则在默认半径 4 内按 registry id 搜索最近方块并打开，返回目标和证据。
- `core.damage_watch`：persistent service，订阅 damage，格式化事件并 notify，演示持续监听和唤醒。

### 验收

- CRUD 与内置不可改删；once/task/service 生命周期、幂等启停、更新/删除清理、持久化恢复。
- 嵌套 start/wait/stop、父取消、深度和循环拒绝、优先级继承。
- 低优先级等待、高优先级 preempted、租约释放、重复事件去重、service 退避与条件关闭。
- 原 233 条回归保持；增加插件与调度回归，`npm test` 和两仓 diff check。
- 真机：启停内置 damage_watch；运行 open_block 搜索并打开模组金桶，读取窗口事件/槽位，关闭界面。DSH 全宿主若未重启则明确标注，不冒充完整会话验收。

## 收尾日志

### 实现与回归

- 新增 `src/plugin/registry.mjs`：core/user 注册、manifest、版本、CRUD、enabled 与可选 JSON 原子持久化。
- 新增 `src/plugin/scheduler.mjs`：动作资源映射、租约、同级等待、高优先级 preempted 与释放唤醒。
- 新增 `src/plugin/manager.mjs`：once/task/service、启停改删、persistent 有界退避、条件关闭、通知去重和恢复。
- 扩展 ScriptRuntime/Worker：受控写动作、notify、ctx.plugins.start/wait/stop、parent/root/depth/plugin stack、优先级继承和父级级联停止；原 sirius_script 仍只读。
- 新增 `sirius_plugin` 和 `core.open_block` / `core.damage_watch`，插件工具总数 30。sirius_stop 统一取消全部插件/脚本 run。
- 自动回归最终 **247 passed / 0 failed**，覆盖 CRUD、嵌套、循环拒绝、父取消、优先级、等待、抢占、service 重启、条件关闭、持久化恢复和系统停止。
- 两处测试场景修正：world_edit 与 combat 不冲突，调度测试改用同一资源；循环测试等待子实例失败，而非误把 start 成功当最终成功。生产代码未因此改变。
- 真机首次通知前缀为 undefined，原因是内部 record.pluginId 被误写为 plugin_id；已修正并增加前缀回归，复测通过。

### 真机证据

- 实际 `core.open_block` 在半径 4 内找到并打开 sophisticatedstorage:gold_barrel，返回 screen_opened/StorageScreen；GUI 实测 117 槽并正常关闭。
- 用户 `user.open_current` 通过 ctx.plugins.start/wait 调用 core.open_block，plugin_stack 为 user.open_current→core.open_block，子实例 parent/root 正确，完成后删除用户插件。
- `core.damage_watch` 持续订阅 damage。创造模式第一次伤害无效，改临时生存后造成 0.5 点真实伤害，通知为 `〔插件·core.damage_watch〕我受伤了：20→19.5，来源 minecraft:generic`；随后治疗到 20、恢复创造并停用监听。
- 完整 DSH 未重启，故只声明真实 createTools/BridgeLink/Worker 客户端垂直验收，不冒充完整 DSH 会话验收。临时脚本已删除，客户端正常关闭，无关 server 未操作。
- 原硬编码 walk/follow/attack/tunnel/chat/observer/autonomy 尚未迁移；技能库与 checkpoint 跨进程恢复仍属后续。
