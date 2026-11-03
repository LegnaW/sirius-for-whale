# 2026-11-03 会话：只读脚本运行时与协议 1.11 对齐

## Plan + Spec（用户已确认结构与第一阶段）

### 结构要点

- 宿主负责调度、权限、事件分发、生命周期和通知；独立 Worker 只执行脚本逻辑。每个 run 独立 Worker，优先可靠的取消/终止而不是最低启动成本。
- `sirius_script.run` 默认后台执行并立即返回 run id，Agent 可继续响应用户；status/logs/stop/list 查询控制，不让长脚本占住 DSH 回合。
- immediate/task/service 共用一套 API。长期 service 后续只开放给随包审查的内置脚本；模型本阶段只创建临时后台 run，不能递归创建脚本。
- 事件与动作后续在同一个 run 内通过异步事件迭代器联动，不为每个事件唤醒模型。通知只能经宿主统一裁决。
- 宿主负责 run/outcome 分离、owner epoch、deadline、Worker 终止、动作租约、日志和 checkpoint；`sirius_stop` 与 init 接管必须让旧 run 失效。
- 事件队列有界并记录 dropped；过滤、背压、去重在连接侧，bridge 保持原始事件。资源互斥和写动作留到下一阶段。

### 本阶段实际范围

新增 `src/script/`：RuntimeManager、Worker bootstrap、纯参数/事件过滤。新增一个 `sirius_script` 工具，插件工具总数由 28 增为 29。

- `run({code,args?,timeout_ms?,wait_ms?})`：立即返回 `run_id`；`wait_ms` 可选 0..2000，仅用于短查询等待，不改变后台语义。
- `status({run_id})`、`logs({run_id,since?,limit?})`、`stop({run_id})`、`list({})`。
- run 状态：queued/running/succeeded/failed/cancelled/timed_out；技术状态和世界 outcome 分开。失败、停止和超时保留 error、日志与终态。
- Worker 中只提供 `ctx.api.call`、`ctx.events.subscribe`、`ctx.sleep`、`ctx.signal`、`ctx.log`、`ctx.checkpoint`、`ctx.args/runId/now/state`。无 require、Node 内置模块、文件、网络、进程、token、任意 DSH 工具或递归脚本。
- 首版 RPC 白名单只读：getStats/getGuiState/world.query/inventory/players/block.get/baritone.status/capabilities/list/chat.history。暂不开放 chat.send、世界写动作、notify 或 service 自动恢复。
- 每次 RPC 检查 run 活跃与身体所有权；stop/init/卸载先使 run 失效，再终止 Worker。强制终止不撤销已发生的动作，因此 outcome 不伪造 confirmed。
- 事件订阅支持 types/uuid/entity_type/item/block/dimension 过滤；每 run 队列有界，满时丢最旧并累计 dropped_count，日志明确报告。run 结束退订。
- 新增 bridge 14 类事件常量供 sirius_events/script 显式订阅。现有 EVENT_KINDS 默认集合不变，避免 block_update/baritone_state 高频事件淹没旧看门狗。

### 验收

- 真正执行提交的代码：只读查询、异步 sleep、事件异步迭代、checkpoint、日志与结果。
- 能力拒绝：写 RPC、require/process/fs 不可用。
- 后台工具立即返回；同步死循环超时终止；stop 取消 sleep；队列溢出计数；run 后无残留监听。
- init 接管和插件卸载使旧 run 失效；状态诊断包含活跃 run。
- `npm test`、两仓 `git diff --check`；README/工具数/提示词同步。
- 真机只读脚本读取状态、订阅 held_item_changed 并完成后台联动，验证期间主会话不被脚本占用。bridge 写动作不在本阶段验收范围。

## 收尾日志

### 实现与自动验证

- 新增 `src/script/contracts.mjs`：只读 RPC 白名单、事件过滤、输入校验与活跃状态。
- 新增 `src/script/worker.mjs`：受限 VM 上下文和 ctx API；提交代码通过真实 `export default async function(ctx)` 执行。
- 新增 `src/script/runtime.mjs`：后台 run store、Worker 生命周期、RPC 代理、事件队列、deadline、stop、日志、checkpoint、诊断和 history。
- `sirius_script` 接入工具面、子代理只读白名单、sirius_status 诊断；init 接管、所有者销毁与插件卸载清理 run。插件工具总数 **29**。
- `CORE_EVENT_KINDS` 对齐 bridge 1.11 的 14 类事件；旧默认订阅不变。README、prompt 和 v2 目标同步。
- 新增 `test/script-runtime.test.mjs` 与 `test/script-tool.test.mjs`，覆盖真实 Worker、能力拒绝、死循环、异步事件、背压、日志序号、所有权和工具操作。
- 最终 `npm test`：**233 passed / 0 failed**。新增工具测试最初错误地要求 wait_ms=0 时必须 succeeded，改为显式等待 2 秒，未改变生产行为。
- 两仓 `git diff --check` 通过；临时真机脚本已删除。无关 server 未操作。

### 真机证据

- 使用实际 `BridgeLink + ScriptRuntime + createTools` 连接协议 1.11 客户端，直接执行真实 `sirius_script` 工具，不是 mock。
- 后台监听脚本立即返回 queued run id；等待 held_item_changed 时 sirius_context 可即时返回。切换快捷栏 7→0 后，脚本收到 before=cd_burner、after=wheat 的真实事件并 succeeded，checkpoint 与日志完整，订阅清空。
- 运行同步死循环时 sirius_context 仍可即时返回；200ms 后 run 为 timed_out/outcome=unknown。长 sleep 可 stop 为 cancelled，最终 list 活跃数 0。选中槽恢复为 7，测试客户端正常关闭。
- 本次未重启完整 DSH 宿主，因此不宣称已通过完整 DSH 会话验收。加载新工具需要重启 DSH，并按 preset 变化要求新建 Sirius 会话。
- 首版只开放只读 RPC；早期草案中的 chat.send 也未开放，保持更严格的只读边界。动作调度、写动作、永久 service、notify、技能库和重连后的 run 恢复属于后续阶段。
