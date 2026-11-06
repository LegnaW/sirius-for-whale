---
name: sirius-builtins
description: 使用 Sirius 官方 core.* 插件，包括移动、战斗、合成、背包搬运、容器存取、输入、截图、开箱和受伤监听。
---

# Sirius 官方内置插件使用指南

先 `sirius_init` 持有身体，再 `sirius_plugin(action:"run", id:"core.x", args:{...})` 启动动作。run 立即返回 run_id，后台执行；用 `sirius_plugin(action:"status", run_id)` 查询进度，最终读取 result。需要常驻监听的插件用 enable/disable 管理，不要用 run 重复启动同一实例。

## 移动与交互

- `core.walk`：安全走到 `{x,z,y?,tolerance?,timeout_ms?}`。必定 allow_break=false、allow_place=false，传入 true 也不会改变。结果包括 arrived/no_path/no_progress/blocked/timeout/interrupted。
- `core.gather {from:{x,y,z},to:{x,y,z},blocks,allow_other_blocks?,max_blocks?,timeout_ms?}`：两角定义含端点的长方体。blocks 必填，为非空方块注册 ID 数组（支持模组 ID），或精确字符串 "all"。只有 "all" 才采集全部可破坏的非空气方块，缺失或空值拒绝执行。allow_other_blocks 默认 false，true 时可清理区域外的沿途障碍。逐轮重扫直到无进展，边采边捡。默认无数量上限，区域最多 4096 格，时限默认 180 秒、最大 280 秒。需要 Bridge 1.17，自动从快捷栏选择合适工具（不会从主背包搬工具）。
- `core.dig_to`：参数同 walk，但必定允许挖除路径障碍且不放置方块。只在明确允许破坏的区域使用；结果字段同样包含 from/to/settled。
- `core.follow`：`{uuid}` 或 `{name}` 二选一，另可给 follow_radius（默认10）、allow_break/place（默认false）。持续跟随，lost/blocked 会通知；用 disable 或 sirius_stop 停止。
- `core.tunnel`：`{height,width,depth,timeout_ms?}`，沿当前水平朝向挖隧道。height 2..16、width 1..16、depth 1..256。先确认允许破坏；结果包括 done/blocked/no_path/no_progress/timeout/interrupted。
- `core.open_block`：`{block,x?,y?,z?,range?,face?,hand?}`。坐标完整时直接打开，否则按 block registry id 搜索 range（默认4）内最近方块。结果含 target 和 evidence。
- `core.drop`：`{slot,count?}` 从指定背包槽位丢物品，count 省略时丢整组，指定时为 1..64。slot 与 inventory 一致：0..8 快捷栏、9..35 主背包、36..39 盔甲、40 副手。走游戏动作层，不按 Q。结果包括 dropped/partial/unknown/empty_slot/count_exceeds_stack/slot_forbidden/carried_item/container_open，并返回 dropped/remaining 实际回读数量。

## 背包与容器

- `core.inventory_move` 使用 `{from_slot,to_slot,count?}`。先打开背包，槽号沿用 inventory 的 0..40，省略 count 搬整组。
- `core.container_exchange` 使用 `{deposit?,withdraw?}`。先用 `core.open_block` 打开箱子。两个数组各填 `{item,count}`，使用完整物品 ID。先存后取，可跨槽。
- 两者执行后保留界面。等待终态再操作窗口。回执依据客户端快照，遇到部分结果或未知时，重读界面和背包再决定剩余操作。

## 战斗与合成

- `core.engage`：显式启动单目标近战，参数 `{uuid?,radius?,min_health?,max_seconds?}`，默认范围 12 格、血量阈值 8 HP、时限 30 秒。省略 UUID 时优先处理已识别的高威胁敌对生物。用 Baritone 安全接近，停止移动后再攻击。低血、被围、目标丢失或接近超时即收手。可用 `sirius_stop` 取消；受击通知照常运行。

- `core.attack`：目标可用 uuid/name/radius。默认 until="hits"，用 count 控制次数；until="dead" 持续攻击同一目标，另支持 interval_ms、wait_cooldown、max_seconds、min_health。不会自动追怪。结果包括 hit/dead/gone/out_of_range/low_health/timeout/interrupted/target_unstable。
- `core.craft` 执行已确认的配方。参数 `{station?,grid,result,count?,x?,y?,z?,range?}`。默认 `station:"table"`，搜索或打开工作台，四格配方映射到左上角。用 `station:"inventory"` 时先打开生存背包，传四格 `grid`，结束后保留界面。空项用 null，非空项为物品 ID 或 `{item,count}`。count 为 1..64 批。脚本等待结果槽及背包增量，结果槽等到截止仍为空时返回 `result_not_ready`。

示例：一根原木合成一批木板：

```json
{
  "grid": ["minecraft:oak_log", null, null, null],
  "result": "minecraft:oak_planks",
  "count": 1
}
```

## 感知与兜底输入

- `core.screenshot`：参数与 sirius_screenshot 相同，保存到当前会话工作区 images/，返回 relative_path；再用官方 read_image 读图，不返回 base64。
- `core.input`：仅在缺少精确对象接口时兜底。`{key:"E",duration_ms?,modifiers?}` 或 `{click:{button,at?,count?,hold_ms?}}`。普通动作优先使用专用插件，不依赖物理键鼠。

## 受伤监听与抢占

`core.damage_watch` 是默认启用的 persistent service，订阅真实 damage，带30秒冷却、1.5秒合并和每分钟唤醒额度。首次伤害会打断优先级低于90的活跃 task，但不停止其它 service，也不会自动反击。通知包含血量、损失和来源。

可通过当前会话 `config/plugins.json` 持久调整 damageCooldownMs、observeWindowMs、maxWakePerMinute、interruptTasks，validate 后 submit；临时 run args 只影响本次实例。修改冷却不会清空 bridge 原始事件。

## 会话脚本与持久配置

`sirius_init` 会初始化当前主会话工作区的 `scripts/`、`config/plugins.json` 和 `state/`。用户插件 `user.foo` 对应 `scripts/foo.mjs`；在 JSON 的 `plugins` 中添加同名条目，设置 manifest、args 和 enabled。core 条目只能改 enabled/args，不能改代码或 manifest。只有 persistent service 可 enabled=true。

编辑后先 `sirius_plugin(action:"validate")`，成功再 `submit`。submit 只重启变化的插件，未变服务保持运行；非法配置不会改变旧挂载。非所有者只能编辑和预检，init 接管后才可 submit。`state/` 是宿主运行状态和最后有效快照，不要编辑。

示例条目：

```json
"user.low_health": {
  "enabled": true,
  "manifest": {"mode":"service","persistent":true,"priority":60,"timeoutMs":0},
  "args": {"threshold":8}
}
```

## 通用管理

- list/get：查看插件和 manifest。
- run/status/logs：启动与检查实例。
- enable/disable：管理常驻期望状态；once/task 完成后 enabled 自动清除。
- sirius_stop：系统级停止全部插件与脚本 run。
- core.* 不可修改或删除；user.* 自制插件才可 create/update/delete。

角点与上限、时限使用 JSON 数字，不要加引号。invalid_args.errors 逐字段说明错误。collected 是期间背包正增量，可能混入其他来源；inventory_delta 含正负变化。remaining 为尚未完成的目标，scan.unknown 是未加载格。pickup_scan_complete=false 时 uncollected={} 不能表示已捡完。脚本不检查血量阈值、固定支撑面或邻接液体；简化策略跳过 Bridge 的补充液体、落沙、脚下支撑保护，仍遵守交互距离和服务端判定。
