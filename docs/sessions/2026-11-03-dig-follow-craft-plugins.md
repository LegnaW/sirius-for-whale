# 2026-11-03 会话：dig_to / follow / craft 基础插件

## Plan + Spec（用户已确认）

新增三个 `core.*` 插件，并固化移动安全策略。旧硬编码工具继续保留用于 A/B，本轮不删除。

### `core.walk` 与 `core.dig_to`

- 两者共用坐标到位、停稳复核、无进展诊断、取消/抢占和设置恢复逻辑。
- walk 必定 `allow_break=false / allow_place=false`，忽略试图打开破坏或放置的参数；保留开门兜底。
- dig_to 必定 `allow_break=true / allow_place=false`，忽略试图关闭破坏的参数；用于矿洞等需要清除路径障碍的场景，不自动放置方块。
- `baritone.goto/follow` 在 `allow_break=true` 时同时申请 movement 与 world_edit 租约，避免与其它世界修改任务并行。

### `core.follow`

- 参数：uuid 或精确玩家 name 二选一，follow_radius 默认 10（1..64），allow_break/place 默认 false。
- 使用 Baritone FollowProcess API；每 2 秒检查目标、距离和自身进展。
- 目标离开追踪范围或跟随被取消则 lost；超过 4.5 秒没有进展则 blocked；结束后停止移动并恢复安全设置。
- 手动停止和抢占不冒充丢失；异常终局通过 ctx.notify 唤醒。

### `core.craft`

- 参考 `ref/dsh-mc-agent/extensions/mc_craft.mjs` 的工作台查找、缺料报告、单批执行、窗口互斥、结果对账与关窗清理。
- 当前 bridge 没有 Mineflayer 的配方注册表，因此首版不宣称自动配方推导或递归规划。Agent 输入 `grid`、`result` 和批数 `count`；插件负责执行和验证。
- 统一使用工作台：指定坐标或搜索默认半径 4 内最近 crafting_table；4 格 2×2 布局会映射到工作台 3×3，不操作物理鼠标。
- grid 为 4 或 9 项，空项为 null，非空项为物品 id 或 `{item,count}`；每格默认放 1 个。count 为 1..64 批。
- 通过角色识别 crafting/result/player/hotbar 槽位，使用 container.transfer 与 container.clickSlot 合法点击；每批核对结果 id，quick_move 取出后复核背包增量。
- 缺桌、缺料、合成格非空、结果不符、没有空背包槽、实际产出不足均如实返回；finally 关窗让服务端收回格内材料，不把中断写成成功。
- 自动配方查询/递归中间产物规划不在当前目标内。模组配方应先由 Agent 通过 JEI、物品提示、文档或实验钻研确认；插件不内置“全配方答案”，也不让模型表现得像未经研究就知道配方。

### 验收

- 单测覆盖 walk/dig_to 参数强制、世界修改租约、follow 丢失/卡住/停止、craft 成功/缺料/结果不符/清理。
- 更新 README、工具数量（仍 30，新增的是内置插件而非工具）、PROGRESS 和 local.md 基线。
- 运行完整 `npm test` 与两仓 `git diff --check`。
- 重启 DSH，在 local.md 指定的多人服验收。walk/dig_to 在安全区域测试，dig_to 只清理由本轮专门放置的可恢复障碍；craft 使用可归还材料，follow 没有第二个真实玩家时明确标注该项真机限制。

## 实施与自动验证

- 提取共享 movementCode：walk 强制 allow_break/place=false，dig_to 强制 allow_break=true/place=false；开门兜底仅 walk 使用。
- 新增 core.follow：Baritone FollowProcess、2 秒监测、4.5 秒无进展、lost/blocked 通知、停止与安全设置恢复。
- 新增 core.craft：显式 4/9 格配方、工作台查找、缺料预检、逐批精确转移、结果 id 和背包增量对账、关窗清理；不提供自动配方答案。
- goto/follow 在 allow_break=true 时同时取得 movement/world_edit；提示词明确 walk/dig_to 分工与模组配方先钻研的约束。
- 新增 6 项专项回归，完整 `npm test`：**261 passed / 0 failed**；两仓 `git diff --check` 通过。
- 首轮真机发现 dig_to 在 CALC_FINISHED_NOW_EXECUTING/pathing 挖掘阶段可能因 4.5 秒无位移被提前停止；已改为执行中允许 15 秒无位移，并增加 6 秒后正常到达的回归。
- craft 真机一次成功：1 原木→4 木板，背包 planks 1→5，关窗后恢复为 1；walk 强制 false/false 并 arrived。
- dig_to 经用户/DeepSeek 手动联合复测通过：屋外带顶临时围栏中，(-316,68,-146) 圆石及同列挡路树叶被挖成空气，run arrived，终点距目标 0.69≤tolerance 1，allow_break=true/allow_place=false；不是绕行。剩余临时围栏已清，圆石补回 188。用户随后明确新要求：保留当前测试场景，不再恢复或清理。
- follow 的 lost/blocked/停止与设置恢复由真实 Worker mock 回归覆盖；本轮没有第二个真实玩家跟随样本，不宣称完成真机跟随。
- DSH 指派问题已定位：复测文本此前只是输入框草稿，未提交，并非模型或 bridge 拒绝任务。重开页面后草稿成功提交，DeepSeek 正常执行 sirius_init 和工具。
