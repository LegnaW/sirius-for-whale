# sirius-for-whale 当前进度

最后更新：2026-11-04

## dev：插件注册、生命周期、编排与动作调度已完成垂直验收

- 当前分支为 `dev`，master 上已有未提交工作完整保留，尚未创建提交。
- `sirius_script` 保持只读；新增 `sirius_plugin`，插件工具总数 **30**。core.* 内置只可启停运行，user.* 可创建、更新、启停和删除。
- once/task/service、幂等启停、更新/删除清理、持久化恢复、persistent 有界退避与有限条件关闭均已实现。
- `ctx.plugins.start/wait/stop` 支持已注册插件编排，最多 8 层，循环拒绝，父结束级联取消，子实例优先级不高于父实例。
- ActionScheduler 实现 movement/world_edit/interaction/inventory/combat 资源租约、等待与高优先级抢占；preempted 不冒充完成。`sirius_stop` 取消全部插件和脚本 run。
- 最新 `npm test`：**281 passed / 0 failed**，Whale `git diff --check` 通过。
- 公开发布准备：README 已精简，完整说明移至 `docs/PLUGIN.md`；本机路径和真实身份示例已脱敏，`persona.txt` 与 `local.md` 均被忽略，仅发布 `persona.example.txt`。已用 LegnaW 创建公开空仓库 `LegnaW/sirius-for-whale` 并配置 origin，**尚未 push**。旧提交历史未改写，仍含早期本机路径/身份示例，首次发布应使用新历史或另行确认历史清洗。
- init 会把全部 core 源码和 manifest 索引生成到会话 `scripts/example/`；副本不参与加载，修改无效，下次 init 覆盖。新增官方 `sirius-plugin-development` Skill，覆盖 ctx API、事件、manifest、嵌套、checkpoint 和自定义插件配置；`sirius-builtins` 继续负责内置参数。规格见 `docs/sessions/2026-11-04-plugin-reference-and-development-skill.md`。
- 会话级工作区配置已实现：`sirius_init` 初始化并挂载 `scripts/`、`config/plugins.json`、`state/`；`sirius_plugin config/validate/submit` 支持预检和差异应用。用户脚本、persistent enabled/args、checkpoint 按会话隔离，非法提交零副作用，未变服务不重启，子代理沿用主会话目录。规格见 `docs/sessions/2026-11-04-session-workspace-config.md`；完整 DSH 真机待验。
- 新增 `core.inventory_move` 和 `core.container_exchange`，共 **13 个**内置。复用现有桥协议和当前打开的界面，支持按玩家槽位搬运和按物品跨槽存取。DSH 真机待验，见 `docs/sessions/2026-11-04-inventory-transfer.md`。
- 新增内置 `core.drop {slot,count?}`。薄调用 bridge 1.12 的 `inventory.drop`，通过游戏动作层丢弃指定槽位物品，count 省略为整组；纳入 inventory 资源调度并同步官方 Skill。真机待验，规格见 `docs/sessions/2026-11-03-drop-plugin.md`。
- 新增内置 `core.input`、`core.screenshot`、`core.walk` 并全部真机通过：E 开关创造背包、实际 JPEG、短距离安全到位与停稳复核。walk 支持 Y≤2、卡住开门、取消/抢占和安全设置恢复，详见 `docs/sessions/2026-11-03-basic-plugins.md`。
- 初始内置 `core.open_block` 与 `core.damage_watch` 真机通过：搜索/指定坐标打开金桶、用户插件嵌套调用、0.5 点真实伤害通知和停用。生命/模式已恢复，临时插件已删除。
- `core.damage_watch` 已对齐旧版伤害监测并默认启用：30 秒冷却、1.5 秒合并、每分钟额度、完整来源与缺失字段处理；旧 Watchdog 的 damage 分支已在宿主接线处停用，`wakeOn.damage` 和原冷却配置继续控制新插件。完整 DSH/多人服真机通过：两次真实 damage 事件均保留，冷却内只唤醒一次且无旧链重复，HP20/生存已恢复，详见 `docs/sessions/2026-11-03-damage-plugin-parity.md`。
- 规格与证据见 `docs/sessions/2026-11-03-plugin-system.md`。随后已完成完整 DSH 会话联合验收：协议 1.11、30 工具、5 内置插件，input/screenshot/walk 均由 DeepSeek 在生存客户端实际调用通过，详见 `docs/sessions/2026-11-03-basic-plugins.md` 的联合验收补记。
- 新增 `core.dig_to`、`core.follow`、`core.craft`，内置插件共 8 个。walk 必定禁止破坏/放置，dig_to 必定允许破坏且禁止放置；允许破坏的 goto/follow 同时申请 world_edit。craft 不自动查配方，由 Agent 先研究再提供 grid/result，插件执行、对账并关窗清理。walk/dig_to/craft 已完成真机验收，dig_to 已确认实际挖穿障碍并到达；follow 仅有 Worker 回归，第二个真实玩家样本待验。规格与证据见 `docs/sessions/2026-11-03-dig-follow-craft-plugins.md`。
- 新增 `core.attack`、`core.tunnel`，内置共 10 个；damage_watch 可在首次伤害时打断低优先级 task 而不停 service、不自动反击。首个官方 Skill `sirius-builtins` 通过 ctx.skills.register 提供全部内置插件用法。
- 可选 `plugins.runStateFile` 实现 task/service checkpoint 跨进程恢复：once 不重放，旧 run 标记 interrupted；craft 支持逐批续做和 resume_conflict。规格见 `docs/sessions/2026-11-03-combat-recovery-skill.md`。官方 Skill、attack、tunnel、init 常驻恢复和受击同步停止 Builder 均已真机通过；跨进程续做真机仍待验。
- core.walk、damage、follow、attack、tunnel 已迁移，旧硬编码 input/screenshot/walk/follow/attack/tunnel 保留用于 A/B；chat/observer/autonomy 尚未迁移。

## master 基线：follow 与丢失提醒已实现，DSH/游戏真机待验

当前工作树包含几组尚未再次提交的功能：

- **单身体所有权、Baritone API、截图缓存、即时 damage、周期维护修复**：既有实现保持不变，周期 tick 已恢复异步状态等待。
- **follow 1.9**：新增 `sirius_follow`，UUID 或精确玩家名单目标；`follow_radius` 默认 **10** 且 agent 可调，破坏和放置默认关闭，立即返回。
- **后台跟随提醒**：每 2 秒读取 follow 状态。目标丢失或 4.5 秒无进展时停止并唤醒一次；进入半径或自身持续移动不误报，状态查询瞬断不误报。
- **统一移动停止**：`sirius_stop` 同时注销后台 walk/follow；新 walk/follow、init 接管和会话销毁只取消不发送丢失提醒。
- 工具面现共 **28 个**，子代理和近聊尾巴已包含 follow，`sirius_status.diagnostics.follow` 可查看当前跟踪状态。
- **主会话黑名单**：默认放行所有已注册工具，只禁用 `bash`、`pwsh`、`plugin_manager`；`skill`、Web、Soul 检索、文件、协作及后续新工具不再逐个加白名单。子代理仍使用白名单。

本轮规格与证据见 `docs/sessions/2026-11-02-follow-tool.md` 和 `docs/sessions/2026-11-02-blacklist-tools.md`。

## 验证与运行状态

- `npm test`：**223 passed / 0 failed**，新增 follow 与主会话黑名单回归；子代理测试未减少。
- 桥端 `./gradlew.bat build`：**689 passed / 0 failed**。
- DSH 已是 0.2.1-rc.2，Soul 真实宿主 **216/216** 通过。
- 协议 1.9 新 jar 与匹配 Baritone API 已部署到实际配置的 `1.21.1-NeoForge_21.1.265` 实例，源/目标哈希一致，旧文件备份在桥仓 `build/runtime-backup/20261102-221737/`。
- Minecraft 尚未用 1.9 重启，因此 damage、follow 和黑名单真机表现仍待验收。

## 下一步

1. 部署新桥 jar 并重启游戏和 DSH，只打开一个测试会话并执行 `sirius_init`；确认协议 1.9、28 个能力和 follow 订阅状态。
2. 验证主会话 skill、Web、Soul 检索可见，`bash`、`pwsh`、`plugin_manager` 不可见；子代理限制保持不变。
3. 跟随一个真实玩家，验证默认 10 格、自定义半径、跟随移动和默认不破坏建筑。
4. 分别制造目标离开与不可达路线，验证丢失/卡住只提醒一次且停止移动。
5. 回归 `sirius_baritone` 状态、`sirius_stop`、新 walk/follow 取代和 init 接管；取消不应产生丢失提醒。
6. 继续完成 damage、周期维护和默认 damage 拉取的既有真机验收。
7. 提交时按所有权、Baritone API、截图、damage、周期维护、能力目录、follow、黑名单和文档拆分，不夹带用户已有的 `persona.txt` 修改。

## 既有遗留

- follow 真机距离、丢失和卡住表现待验；状态查询瞬断已由单测覆盖。
- 当前身体所有权只覆盖同一插件进程；独立多个 DSH 进程之间的身体租约尚未实现。
