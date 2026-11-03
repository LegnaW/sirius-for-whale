# 2026-11-02 目标：把重复动作下沉成"自动任务"（省 token，**不拦 agent**）

> 状态：**目标与方案，尚未开工**（等 用户拍板优先级/待决问题）
> 前提澄清（用户2026-11-02）：**永远不拦截 agent 自己的攻击/挖掘命令**。自动化不是权限闸门，
> 而是"别让模型为了做同一件事重复开几十轮"。
> 落点：`sirius-for-whale`（插件侧为主，必要时才动桥）。

---

## 0. 一句话

模型下**一次意图 + 终止条件**（"把附近清干净"、"采 32 块石头"、"打到它死"），
身体自己跑几十到几百 tick，跑完回一份带证据的汇总。模型不再逐动作推。

## 1. 为什么值得做（token 账）

现在每一步动作都是一整轮上下文（assistant 消息 + 工具结果 + 历史重发）。真实手续费不在动作，
在"这一步又是一轮"。同一个任务，M3.5 把原语下沉后实测 **212k → 16k token**
（`Sirius-Minecraft/docs_agent/PROGRESS.md:754`）。

1.6 真机测试里的浪费样本（`<本地测试目录>\sirius-测试结果-1.6.md`）：

| 场景 | 现在 | 步数 |
|---|---|---|
| 打死一只僵尸（C6/C7） | `attack` → 看结果 → `attack`… | 3 次调用起 |
| 挖一块石头（H2） | 一次 `dig` 7.9s | 1 步（但 32 块 = 32 步） |
| 放方块失败重试（G1） | `place` → 读错因 → 再 `place` | 3 步 |

按"打 3 只怪 ≈ 10 步、采 32 块石头 ≈ 64 步"估，一个 20 步的上下文每步重发 ~15k token，
就是 **30 万 input token 换一堆"还在打"**。

## 2. 设计原则（四条）

1. **意图 + 终止条件**，不是逐动作。参数里必须有"什么算完成"（`count` / `until` / `radius` / `max_seconds`）。
2. **汇总带证据**：打了谁、命中/未命中、每个目标血量变化、挖到什么、掉落有没有捡到、耗时。
   —— 没有证据的自动化等于黑盒，模型还得回头查。
3. **零成本短路**：不满足前提时 1 秒内返回（`defend` 没敌人 → `clear`；`mine` 附近没这种方块 →
   `not_found` + 最近的在哪）。绝不跑满超时。
4. **可被打断**：循环跑着时模型任何手动动作（`dig`/`place`/`attack`/`walk`）都覆盖它 →
   该循环返回 `interrupted`（附"被哪个动作打断"），**不是报错**，也不需要事后清理。

## 3. 通用骨架

沿用仓里现成的 `WalkTracker` 模式（`src/walk.mjs`：`start` → 定时 `tick` → 终止 → `finish` → 通知）：

```
start(意图+终止条件)            ← 一次工具调用，立刻返回 started 或结论
  tick() 每 0.5~2s 推进一次      ← 只花 RPC，不花 token
  条件满足 / 超时 / 被打断
    → finish(汇总统计)           ← 一次工具结果
    → sharedState.notify(一行)   ← 后台任务另发一条 steer 通知（模型不用轮询）
```

与现有动作层的关系：这些循环**占用身体**。桥侧的动作是进程级单例（`DigTools.active`
等），所以模型手动动作会顶掉循环 —— 这点写进工具描述，别让模型以为是 bug。

## 4. 待实施原语（按性价比）

| # | 工具 | 现在要模型做什么 | 下沉后 | 成本 | 依赖 | 风险 |
|---|---|---|---|---|---|---|
| 1 | `sirius_mine {block, count, radius?}` | 每块一次 `dig` + 查掉落 | 内部走 Baritone `#mine <数量> <方块>`，轮询背包到数量够 | 2~3h | 无桥改动（`#mine` 是现成的） | 会走远、会挖穿路上的方块（`allowBreak` 默认 true） |
| 2 | `sirius_attack {until:"dead"}` | 只有 `count:N`，打不死要再来一轮 | 循环 `entity.attack {count:1}` 直到目标消失/自己血低/超时 | ~1h | 现有 `entity.attack` | 击退后目标出 3 格要先靠近（可复用 walk） |
| 3 | `sirius_defend {radius, until:"safe"}` | "有怪吗→打谁→打→还有吗" | 一次调用清半径内所有 `Monster`，没有就 `clear` | 3~4h | `world.query entities` + `entity.attack` | 苦力怕/远程怪要特殊处理；别打宠物/村民 |
| 4 | `sirius_tunnel {height, width, depth}` | 逐格挖 | 直接 `#tunnel`，轮询位置/方块变化 | 1~2h | 无桥改动 | 方向绑定玩家朝向；起点在脚下 |
| 5 | `sirius_mine_to {x,y,z}` | 逐格挖通 | `allowBreak` + `#goto`，到点**立刻恢复** `allowBreak=false` | 3~4h | 无桥改动 | **会拆路上所有可破方块**（上次砸玻璃事故）；需要显式开关 + 事后报告挖了什么 |

补充说明：

- 第 1、4 条基本是"白送"——Baritone 早就实现了，我们只是没包成工具。
- 第 2、3 条只是在现有 `entity.attack` 外面套循环，**不需要协议升级**。
- 第 5 条风险最高，单独一轮讨论（先做"逐格 `dig` 的可控版"可能更合适）。

## 5. 和"自动反击/无人值守"的关系

是同一套循环，区别只在**谁打开**：

- 模型喊一声（`sirius_defend` 或 `guard: on` 常驻）→ 省 token（本轮范围）
- 没人喊也一直开 → 无人值守自保，**要求循环住在桥侧**（DSH 没开也能跑），
  属于另一轮，且要先解决"谁拥有自动动手的权力"（身体租约/连接码一题）。

历史设计备注：`sirius-brain` 曾有过三级反射等级（L0 观察 / L1 自保 / L2 自卫预留，
`reflexes.py:55`、`docs_human/overall.md:539`），但那套是**限制模型能动什么**的框架，
与本轮"省 token"的目标不同；本轮沿用其中有用的部分（危怪判定、只逃不打的默认、苦力怕例外），
不做等级闸门。

## 6. 参考资料

### 6.1 Sirius-Minecraft（兄弟仓库）

| 用途 | 位置 |
|---|---|
| 工作方式/门禁/文档地图 | `docs_agent/RULES.md` |
| 构建命令、schema 链、常见坑 | `docs_agent/DEVELOPMENT.md` |
| 技术规格（含 §8.6 参考项目价值清单） | `docs_agent/sirius-technical.md` |
| 跨会话状态锚点 | `docs_agent/PROGRESS.md`（`754` 行是 212k→16k 那条） |
| 历史轮次日志 / 交接报告 | `docs_agent/session/`、`docs_agent/reports/` |
| 桥的接口与词表 | `sirius-bridge/src/main/java/io/sirius/bridge/{ToolContracts,PlaceTools,DigTools,EntityTools,UseItemTools}.java` |
| 人读版全局技术文档 | `docs_human/overall.md`、`docs_human/sirius-design.md` |

### 6.2 Baritone 源码（1.21.1 分支，HEAD `11ea66c`）

根：`../baritone`

| 事实 | 位置 |
|---|---|
| `allowBreak` **默认 true**（寻路自己挖通） | `src/api/java/baritone/api/Settings.java:63` |
| `blocksToAvoidBreaking` 默认只"尽量不挖"工作台/熔炉/箱子/陷阱箱（成本惩罚，不是禁区） | `Settings.java:254` |
| 生物避让（只躲不打） | `Settings.java:477`（`mobAvoidanceCoefficient` 1.5）、`:482`（`mobAvoidanceRadius` 8） |
| `#mine <数量> <方块...>`（按类型+数量收集） | `src/main/java/baritone/command/defaults/MineCommand.java:41-49` |
| `#goto` 坐标 vs 方块两种语义 | `command/defaults/GotoCommand.java:46-56` |
| `#tunnel <h> <w> <depth>`（起点脚下、朝向决定方向） | `command/defaults/TunnelCommand.java:39-79` |
| 全部命令清单（**没有 attack/fight**） | `command/defaults/DefaultCommands.java:33-71` |
| 程序接口：`mine(quantity, lookup)` / `mineByName` | `src/api/java/baritone/api/process/IMineProcess.java:39,49,56,74` |
| `getToBlock(...)`：走到最近的某种方块 | `api/process/IGetToBlockProcess.java:28-34` |
| 进程/行为总览：9 个 Process + `getLookBehavior` | `api/IBaritone.java:41-95` |
| 特性与用法 | `FEATURES.md`、`USAGE.md` |

### 6.3 参考实现（战斗/自动化的现成逻辑）

- **Mindcraft CE**：`../mindcraft-ce`
  - `src/agent/modes.js:167` `self_defense`（`interrupts: ['all']`，8 格内最近 hostile，路径通就打）
  - `src/agent/library/skills.js:334` `attackEntity`（`pvp.attack` + 轮询直到消失 + 捡掉落）
  - `src/agent/library/skills.js:370` `defendSelf(bot, range)`（装备最好武器 → ≥4 格追、≤2 格退 → 每 500ms 复查）
  - `skills.js` `equipHighestAttack`（先剑、再斧、再镐铲）；modes 里还有 `cowardice`（低血逃）/`hunting`（闲着打）
- **Numen**：`../minecraft-numen`（1.21.1）——Menace 简化、反射链调度；
  "开关矩阵是删空闸的坑"的教训来源（见 `sirius-technical.md` §8.6）
- **N.E.K.O**：`../N.E.K.O`——证据数学/反思层/任务帧
- **NeoForge 文档（离线快照）**：`../Documentation-main`
  （用 `versioned_docs/version-1.21.1/` 那一份）

### 6.4 DeepSeek Harness 插件编写参考

**harness 安装根**：`<本机 npm 全局目录>/@deepseek-ai/dsh/`

**技能目录（写插件/写装配的权威说明，四个）**：
`<dsh 安装根>/node_modules/@deepseek-ai/dsh-agent-preset/skills/`

| 技能 | 用途 | 入口 |
|---|---|---|
| `cordis-plugin-development` | 写插件：工具、页面、面板、UI 对象、MCP 连接、调试 | `skills/cordis-plugin-development/SKILL.md`（细分 `references/{host-plugin,ui-plugin,mcp-bundle,user-actions,practices,verification}.md`） |
| `cordis-composition-reference` | Loader YAML / `cordis.patch.yml` 语法、可安装包清单 | `skills/cordis-composition-reference/SKILL.md`（+ `references/packages.md`） |
| `editing-cordis-compositions` | agent preset / composition 的编写与校验 | `skills/editing-cordis-compositions/SKILL.md` |
| `agent-experience` | 工具定义与描述、提示词章节、技能/上下文效率（"别让模型花 token 猜"的原则在这） | `skills/agent-experience/SKILL.md` |

用法：会话里用 `skill` 工具按名字加载（例如 `skill cordis-plugin-development`），
不加载时不会进上下文——这是省 token 的机制本身。

**插件实现参考（读源码比读文档准）**：
- agent 主循环 / 消息投递：`<dsh 安装根>/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`
  其中 `steer(input)` = `send(input, 'next-step', true)`，**逐条进 inbox、不合并**
  → 这是"一条唤醒被回好几遍"的成因（见 §5 与 `notes/2026-11-01-p0-fixes.md`）
- 装配与作用域：`dsh-agent-preset-registry`、`dsh-cordis-host-runner`、`dsh-tool-skill`、`dsh-skill`

**本插件怎么被加载**：profile 可以使用指向本仓库的目录链接；改仓库文件后**重启 DSH** 即生效，预设（`preset-sirius`）改动需要开新会话。

**本仓自己的模板**（写新工具/新 tracker 时照着抄）：
- `src/walk.mjs` —— `WalkTracker`：后台任务 + 终止条件 + 通知（本轮所有自动任务都按它写）
- `src/tools.mjs` —— `defineTool` / 摘要与词表约定 / `toLosslessJSON` / `withDisplay`
- `test/walk.test.mjs` —— 后台任务的测试写法（fake link，不连游戏）

### 6.5 证据与测试

- 测试记录保存在本机测试目录，不随仓库发布。
- 桥审计日志位于 `<游戏实例>/logs/sirius_bridge.log`，每次工具调用一行，可用来数"步数"。
- 省 token 的验收方法：同一任务前后对比该日志里 `REQUEST ... method=` 的行数

## 7. 验收标准（可量化）

1. 采 32 块同种石头：**≤ 3 次工具调用**（现在 ≈ 64 次）
2. 打光 3 只怪：**≤ 2 次工具调用**，且返回汇总含每只的命中/未命中/血量变化
3. `defend` 在半径内无敌人时：**≤ 1 秒**返回 `clear`
4. 手动动作打断自动任务：返回 `interrupted` + 打断者名称，且身体状态干净（没有半途的朝向/界面残留）
5. 审计日志步数下降 ≥ 80%（同一任务 A/B 对比）

## 8. 待决问题（需要 用户拍板）

1. `sirius_mine` 走 Baritone `#mine`（快、会走远、会挖穿路上的方块）还是逐格 `dig`（慢、只挖指定范围）？
   倾向：`#mine` + 半径上限。
2. `sirius_defend` 只打 `Monster`，还是也包含"先攻击我的玩家"（需要 `lastHurtByMob` 判断）？
3. 自动任务的默认时限与"血低自动收手"阈值（建议 `max_seconds: 60`、`min_health: 8`）？
4. 自动任务是否只在"持有身体"的会话里跑（与连接码/身体租约一题联动）？
5. 本轮先做哪几个：建议 **1 + 2 + 3**（都不用改桥、不用升协议）。
