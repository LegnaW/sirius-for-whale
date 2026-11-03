# 2026-11-02 会话：v2 脚本化重构方案

## Plan + Spec（用户已确认开发理念）

下一版不再继续堆叠写死的工具、后台 Tracker 和提醒器。模型可以编写短期 JavaScript，组合可信的 bridge 原语和事件订阅；经过验证的流程保存为技能。已有高层工具与内置提醒逐步迁移为随包发布的初始脚本。

本轮在 `dev` 分支记录架构和迁移顺序，尚未改变运行时行为。基线 `npm test`：223 passed / 0 failed。

参考：`ref/dsh-mc-agent` 的高层工作流、任务恢复和调度；工作目录 Argon 论文的模型自写程序、短执行闭环、持久辅助函数与诚实验证。不采用多智能体模式，不切换到 Mineflayer。

## v2 两大开发板块（2026-11-03 用户确认）

### 板块一：完善接口底层

先补齐脚本所需的通用游戏对象、事件和事务能力，不把每个业务操作继续写死成模型工具。当前优先项：

1. `block.get`：单格读取、完整方块状态，并区分空气、区块未加载和坐标越界。
2. 容器事务：`container.clickSlot` / `container.transfer` / `container.close`，使用真实菜单槽位，不再依赖 GUI 缩放和物理鼠标。
3. 后续再补核心事件、物品开始/停止使用、批量感知和统一动作句柄。

底层返回值必须保留证据与不确定性，不能把客户端预测、已发包和服务端确认混为一谈。

动作约束（2026-11-03 用户确认）：agent 优先调用原版/模组动作层和精确对象接口，物理鼠标键盘仅作没有动作接口时的兜底。新增和修改动作必须检查合法交互距离、视线、权限与参数，不伪造越权包或规避服务端规则。合法构造不等于服务器必然接受；拒绝与未知结果必须如实返回。

事件职责边界（2026-11-03 用户进一步明确）：bridge 忠实采集并投递客户端观察到的原始事件，不做业务筛选、合并、冷却或默认降频；事件筛选、背压、去重和处理策略由连接侧及其脚本负责。`block_update` 等高频事件是否值得接收由订阅者决定。

### 板块二：编写自带插件

在稳定底层之上，把已有业务功能改写为随包发布的初始脚本插件：walk、follow、attack、damage、chat、observer、autonomy 等。自带插件与模型即时代码使用同一公开 API；高频流程经脚本验证后再沉淀为技能，确有性能或实时性要求的部分才保留原生实现。

两板块按“接口底层 → 自带插件”推进，但每个底层垂直切片都必须能被真实调用和验证，不一次性补齐所有假想 API。

## 设计边界

### 留在宿主的核心

这些能力是所有脚本共享的可信执行底座，不脚本化：

- `BridgeLink`：连接、token 发现、RPC 配对、超时、事件环和跨重连重订。
- 身体所有权：只有 init 主会话及其子代理可行动；接管和销毁必须使旧 run 全部失效。
- 能力目录和权限：脚本只能调用明确放行的 bridge 方法，不能读取 token、访问任意工具或递归执行脚本。
- 动作调度：movement / interaction / inventory / combat 资源互斥，查询和聊天不阻塞。
- 生命周期：run id、owner epoch、deadline、取消、Worker 终止、断线和插件卸载清理。
- 事件总线：有界队列、按 run 分发、退订、背压和原始事件留存。
- 通知出口：所有权检查、硬限流、去重和 `deliverWake`；脚本不能直接调用 `agent.steer`。
- 持久化与审计：代码、参数、日志、动作结果、checkpoint、终局和最终状态证据。
- `sirius_stop`：始终可越过脚本停止身体动作，不能被脚本禁用或覆盖。

### 迁移为初始脚本

- `walk`：目标、到达公差、进展检测、开门、超时、后台完成通知。
- `follow`：目标、半径、丢失和无进展处理。
- `attack_until_dead`：锁定目标、冷却、低血、超距和超时。
- `use_item`：按物品交互进度等待并核对结果。
- `tunnel`：启动 Builder、轮询状态、区域复核和恢复安全设置。
- `damage`：伤害格式化、来源显示、冷却和唤醒请求。
- `chat`：自我过滤、叫法评分、距离修正、强弱唤醒和防操纵。
- `danger`：death / health_low / fire / drown 提醒。
- `observer`：定时观察、快照差异、沉默和退避。
- `autonomy`：空闲、短轮回退和自主提醒。
- `chat_tail`：作为脚本库函数，在动作结束后读取增量聊天，不再由宿主逐工具硬编码名单。

初始脚本与模型脚本使用同一公开 API，不允许初始脚本走隐藏后门。它们的配置和可信来源由包管理；模型保存的技能有独立命名空间。

## 脚本契约

每个技能由 manifest 和异步函数组成。manifest 声明名称、版本、参数 schema、资源、事件和默认时限。模型即时代码与初始脚本共用以下概念接口：

```js
export default async function run (ctx) {
  const stats = await ctx.api.call('getStats', {})
  for await (const event of ctx.events.subscribe({ types: ['damage'] })) {
    ctx.log(event)
    if (ctx.signal.aborted) break
  }
  return { health: stats.health }
}
```

公开能力：

- `ctx.api.call(method, params, options)`：调用白名单 bridge 原语；每次调用检查 owner epoch、取消和 deadline。
- `ctx.events.subscribe(filter)`：异步事件迭代器；run 结束自动退订，队列有界并报告丢弃。
- `ctx.sleep(ms)`：可取消等待。
- `ctx.signal`：合作式取消信号。
- `ctx.log(value)`：有大小和条数限制的结构化日志。
- `ctx.state` / `ctx.checkpoint(value)`：仅 JSON 数据，用于恢复；不保存不透明进程全局对象。
- `ctx.notify(text, options)`：发送通知意图，由宿主统一裁决，不保证一定唤醒。
- `ctx.args` / `ctx.runId` / `ctx.now()`：本次输入与运行信息。

脚本没有 `require`、Node 内置模块、文件、网络、进程、任意宿主工具、`sirius_command` 或递归脚本执行能力。截图文件等必要副作用由特定宿主能力完成并只返回路径。

## 执行模型

- 第一阶段使用 Node 22 自带 `worker_threads` 和受限 VM 上下文，不新增依赖。
- Worker 只接收代码、JSON 参数和能力请求，不接触 token 或真实 bridge socket；RPC 全部由宿主代理。
- 宿主 deadline 和 `worker.terminate()` 处理死循环；每次能力调用和 sleep 做合作式取消。
- 这是**能力隔离和事故防护**，不是抵御恶意代码的强安全沙箱。游戏聊天或网页内容不得自动转化为可执行代码；初始脚本需随包审查，模型脚本仍视为有副作用的代码。
- 脚本强制终止不撤销已发生的游戏动作。终局必须把技术状态和世界证据分开：
  - run：`queued/running/succeeded/failed/cancelled/timed_out`。
  - outcome：`confirmed/failed/unknown`。
- 脚本返回的成功文本只是声明；宿主尽可能附最终状态、动作 verdict 和前后差异，不能把异常分支当成已确认成功。
- 前台短运行与后台长运行共用 run store。长任务靠有界执行片和 checkpoint 恢复，不靠永不结束的默认脚本。

## v2 工具面

迁移完成后默认只保留少量入口：

- `sirius_init`：取得身体。
- `sirius_status`：连接、所有权、活跃 run、资源和事件订阅诊断。
- `sirius_script`：run / status / stop / logs，执行即时代码。
- `sirius_skill`：list / get / save / run / delete，管理验证过的技能。
- `sirius_task`：长任务 checkpoint、恢复和取消。
- `sirius_stop`：紧急停止身体并取消活跃动作。
- `sirius_say`、`sirius_screenshot`：常用直接能力保留，也可在脚本中调用。

其余底层动作主要作为脚本 API，不再要求每个都占一个模型工具名。旧 28 工具在开发期通过兼容开关保留；只有对应脚本的参数、返回和真机行为验收后，才从默认工具面移除。旧配置和旧会话不作为 dev 分支首轮兼容承诺，但迁移过程必须有可回退路径。

## 实施阶段

### 阶段 0：基线与规格（本轮）

- 创建 `dev`，保留现有未提交工作。
- 固定 223 条插件回归和本文契约。
- 不修改 bridge 协议，不删除现有实现。

### 阶段 1：只读脚本垂直切片（2026-11-03 已完成源码与真机垂直验收）

- 实现 run store、Worker、能力代理、deadline、取消、日志和诊断。
- 实际只开放只读感知与事件订阅，chat.send 和世界写动作均未开放，比早期草案更严格。
- 真实 Worker 与真实客户端脚本已验证查询、held_item_changed、死循环终止、init 接管和停止；重连恢复与完整 DSH 会话验收仍待后续。
- 实现与证据见 `docs/sessions/2026-11-03-readonly-script-runtime.md`。

### 阶段 2：动作调度与第一个动作脚本（core.walk 已完成首个迁移）

- 已实现资源租约、owner epoch、优先级等待/抢占和系统级统一 stop；preempted 与 completed 分开。
- 已实现 core/user 插件注册、once/task/service、CRUD、嵌套编排、持久化恢复、有限重启与 ctx.notify。
- `core.open_block`、`core.damage_watch`、`core.input`、`core.screenshot` 与 `core.walk` 均已完成真实客户端验收；详见 `docs/sessions/2026-11-03-plugin-system.md` 和 `docs/sessions/2026-11-03-basic-plugins.md`。
- 旧硬编码 input/screenshot/walk 工具保留用于 A/B；follow/attack/tunnel 等尚未迁移。core.walk 已覆盖 Y 公差、开门、卡住、后台通知、取消与抢占。

### 阶段 3：事件脚本

- 先迁移 damage 和 danger，再迁移 chat、observer、autonomy。
- 原始事件始终保留；冷却和限流只影响唤醒。
- 保留 golden 聊天语料、自我过滤、近期聊天去重和独立危险额度。

### 阶段 4：其余动作与技能库

- 迁移 follow、attack、use_item、tunnel。
- 增加技能保存、检索、版本、参数和验证记录。
- 通过真实脚本组合合成、箱子、建造和采集；只有高频且稳定的流程再原生工具化。

### 阶段 5：默认切换与清理

- 默认启用新工具面和初始事件脚本，旧工具进入显式兼容模式。
- 删除已被替代且没有兼容调用方的 Tracker、硬编码提醒和过时提示词。
- 更新 README、工具数、配置和安装说明；完成真机验收后再合并 master。

## 自动验收

- 保留现有测试；明确删除的行为才能删除对应测试，不能为了变绿降低断言。
- Worker 必须运行真实提交的代码，不只测试 import 或 mock 返回值。
- 覆盖：能力拒绝、同步死循环、异步取消、超时后的世界状态 unknown、事件背压、退订、重连 seq 重置、owner 接管、资源互斥和插件卸载。
- 每个迁移脚本保留原工具的关键回归，另测脚本与旧实现 A/B。
- 每阶段运行 `npm test` 和 `git diff --check`。

## 真机验收

- 模型现场写脚本读取状态、背包并订阅 damage。
- 模型现场写短脚本组合观察、挖掘和结果回读。
- walk 脚本完成安全坐标移动、开门、卡住和 stop；后台运行期间主会话可聊天。
- 死循环被终止后 DSH 仍可操作，身体能通过 `sirius_stop` 停下。
- init 接管后旧脚本不能继续行动；重连后订阅恢复且旧事件不重复投递。
- 玩家、怪物和弹射物伤害提醒、聊天 golden 场景、观察与自主退避行为不退化。

## 非目标

- 不引入多智能体分工。
- 不让脚本拥有宿主机任意代码执行权限。
- 不把底层实时控制搬到 JS 网络往返中；Baritone、挖掘、攻击冷却和真实事件捕获仍由 bridge 负责。
- 不追求一次重写所有功能；每个垂直切片都可运行、可回归、可回退。
