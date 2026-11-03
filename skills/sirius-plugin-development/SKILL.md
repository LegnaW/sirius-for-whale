---
name: sirius-plugin-development
description: 编写、调试和持久化 Sirius user.* 插件；涵盖 ctx API、事件订阅、生命周期、嵌套编排、工作区配置与完整示例。
---

# Sirius 自定义插件开发

需要编写新插件时加载本 Skill；需要查询 core.* 的参数时另加载 `sirius-builtins`。init 生成的 `scripts/example/` 包含当前版本全部 core 源码和 `index.json` manifest 索引，可直接参考其实现。

## 1. 工作区与生效流程

每个 Sirius 主会话使用自己的工作区：

```text
scripts/
  example/                 # init 生成的 core 参考副本，不参与加载
  <name>.mjs               # user.<name> 的实际源码
config/plugins.json        # 声明式配置
state/                     # 宿主维护，不要编辑
```

开发流程：

1. 主会话执行 `sirius_init`，取得身体并生成目录和参考副本。
2. 阅读 `scripts/example/` 与官方 Skill，编写 `scripts/<name>.mjs`。
3. 在 `config/plugins.json` 的 `plugins` 中添加同名 `user.<name>` 条目。
4. 调用 `sirius_plugin(action:"validate")`，修正全部错误。
5. 身体所有者调用 `sirius_plugin(action:"submit")` 挂载差异。
6. 一次性动作用 `run`，persistent service 用配置 `enabled:true`；用 `status/logs` 调试。

example 中的文件即使修改也不会被加载，下次 init 会覆盖。core 在 JSON 中只能改 `enabled/args`，不能改代码或 manifest。非所有者可编辑和 validate，但不能 submit 改变游戏。子代理沿用主会话工作区。

只有 `mode:"service"` 且 `persistent:true` 的用户插件可在配置中 `enabled:true`。once/task 和非持久 service 用 `run` 启动；临时 run args 不改配置。submit 对非法输入零副作用，未变化的 service 不重启。

## 2. 最小插件与 manifest

```js
export default async function (ctx) {
  const stats = await ctx.api.call('getStats', {})
  return { result: 'ok', position: stats.position ?? null }
}
```

对应配置：

```json
"user.my_position": {
  "enabled": false,
  "manifest": {
    "mode": "once",
    "priority": 50,
    "timeoutMs": 30000
  },
  "args": {}
}
```

脚本必须 `export default async function(ctx)`，最大 64 KiB，args 和返回值必须可 JSON 序列化。脚本在独立 Worker 的受限 VM 中运行，没有 require、process、文件、网络、shell 或原生 timers；使用 `ctx.sleep`，不要访问宿主资源。

manifest 字段：

| 字段 | 含义 |
|---|---|
| `mode` | `once` 一次执行；`task` 有终局的后台任务；`service` 持续监听/服务 |
| `priority` | 用户插件 1..80；高级可抢占低级冲突任务，子插件不能高于父插件 |
| `timeoutMs` | 0 不限时，或 100..300000；service 通常为 0 |
| `persistent` | service 失败后按退避策略重启，并允许配置持久 enabled |
| `maxRestarts` | 0..20，默认 3 |
| `restartDelayMs` | 50..60000，默认 500，指数退避 |
| `args` | 默认参数；JSON 顶层 `args` 与这里二选一，推荐顶层 |
| `description` | 可选说明 |

`enabled` 是持久期望状态，`active` 是实际运行实例。once/task 完成即结束；非持久 service 可条件完成；persistent service 手动停用才清除期望状态。超过重启上限后实际状态可能停用，应查看 active/logs，不只看配置。

## 3. ctx 接口

### 基本值与控制

- `ctx.args`：manifest 默认 args 与本次 run args 合并后的对象。
- `ctx.runId`：当前 run ID。
- `ctx.signal`：AbortSignal；长循环每轮检查 `ctx.signal.aborted`。
- `ctx.sleep(ms)`：0..300000，可取消的等待。
- `ctx.now()`：当前毫秒时间。
- `ctx.log(value)`：写入 run 日志，用 `sirius_plugin(action:"logs",run_id)` 查看。
- `ctx.state`：当前 Worker 内的临时对象，不是跨进程存储。
- `await ctx.checkpoint(value)`：保存 JSON checkpoint，供跨进程续做。
- `ctx.notify(text)`：通过宿主唤醒身体所有者；按插件做短间隔去重，不要刷屏。
- `ctx.screenshot(params)`：保存到主会话工作区 images/，返回路径。

恢复时，宿主把旧 checkpoint 和旧 run ID 放进本次 `ctx.args.resume_checkpoint` / `resume_from`。插件必须核对真实世界状态，已发生的游戏副作用不会回滚，once 不自动重放。

### `ctx.api.call(method, params)`

只读方法：

```text
getStats, getGuiState, world.query, inventory, players, block.get,
baritone.status, capabilities/list, chat.history
```

注册插件可用动作方法：

```text
dig, place, use, useItem, entity.use, entity.attack,
inventory.select, inventory.drop,
container.clickSlot, container.transfer, container.close,
baritone.goto, baritone.follow, baritone.settings, baritone.stop, baritone.tunnel,
input.key, input.mouseMove, input.click
```

优先使用精确对象和动作层接口。input.* 仅作缺少动作接口时的兜底。ActionScheduler 按 movement/world_edit/interaction/inventory/combat 仲裁：低级冲突等待，高级抢占；run 结束释放租约。父脚本等待子插件前不要提前持有子插件需要的同一资源。

### `ctx.plugins`：复用已注册插件

```js
const run = await ctx.plugins.start('core.open_block', { block: 'minecraft:chest', range: 4 })
const done = await ctx.plugins.wait(run.run_id)
```

- `start(id,args)`：启动 core.* 或 user.*，立即返回 run；不改变 enabled。相同插件已有活跃实例时返回既有 run。
- `wait(runId)`：等待最终记录；先检查 `done.status`，成功结果在 `done.result`。
- `stop(id)`：停止同一 root 调用树中的插件。
- `interrupt({mode:'task'})`：抢占低于当前调用者优先级的任务，不误停其他 service。

调用树记录 parent/root/plugin_stack；A→B→A 等循环拒绝，最多 8 层。子有效优先级取父/子较低值，父结束会级联停止活跃子插件。不能通过嵌套执行未注册代码。

## 4. 事件订阅

```js
export default async function (ctx) {
  const events = await ctx.events.subscribe({ types: ['damage'] })
  for await (const event of events) {
    const data = event.data ?? {}
    await ctx.log(`damage ${data.amount ?? '?'}`)
    if (ctx.args.once) break
  }
  return { result: 'stopped' }
}
```

`subscribe(filter)` 返回异步迭代器。`for await` 的每个 `event` 至少含 `event`（类型）、`data`、`seq`。也可手动 `next()`，但同一迭代器不能并发 next；`return()` 退订。run 停止会清理订阅。

过滤字段：

| 字段 | 匹配规则 |
|---|---|
| `types` | 必填字符串数组，最多 32；空数组表示全部，`'*'` 也表示全部 |
| `uuid` | 匹配 data 内嵌套的实体/玩家 UUID |
| `entity_type` | 精确匹配 `data.type` |
| `item` | 匹配 data 内嵌套的物品 ID |
| `block` | 匹配 `data.block`、`data.before.block` 或 `data.after.block` |
| `dimension` | 精确匹配 `data.dimension` |

每个订阅有独立有界队列，溢出会累计 dropped_events 并写日志。bridge 原始事件不做业务冷却、合并或默认降频；插件必须自行去重、限频和选择必要 types，尤其不要无处理地唤醒全部 block_update。

### 事件目录与主要 data

| 类型 | 主要字段 |
|---|---|
| `chat` | `message`、`system`、玩家行的 `sender` |
| `gui_open/gui_close` | `screen` |
| `death` | `health`、`air`、`on_fire` |
| `damage` | `health_before/after`、`amount`、`damage_type`、nullable `attacker/direct_entity` |
| `fire` | `health` |
| `health_low` | `health`、`threshold` |
| `drown` | `air` |
| `block_update` | `x/y/z`、`dimension`、`before/after:{block,state}` |
| `entity_spawn/entity_gone` | 实体 `id/uuid/type/name/position/dimension`；gone 另有 `dead_or_dying` |
| `entity_hurt` | 实体字段、`health`、`damage_type`、nullable 来源 |
| `entity_death` | 实体字段及可用的最近伤害来源 |
| `item_pickup` | 物品/拾取者 ID、`amount`、可用堆叠信息 |
| `player_join/player_leave` | 玩家实体字段 |
| `window_open/window_close` | `container_id`、`screen` |
| `slot_update` | `container_id`、`state_id`、`packet`、菜单 `slot`、`stack` |
| `held_item_changed` | `previous_slot/slot`、`before/after` |
| `connection_state` | `state:connected/disconnected`、nullable `player` |
| `baritone_state` | 完整 baritone.status、`reason` |
| `screenshot` | `image_b64`、`format`、`width/height/quality`，高体积，非必要不订阅 |

`evidence` 区分客户端观察、服务端数据包和 Baritone API。`server_packet` 证明服务端发送了该状态，不证明此前某个动作成功。结果未知时重读世界，不猜成功。

## 5. 完整示例：开箱、存物、关窗

```js
export default async function (ctx) {
  const runAndWait = async (id, args) => {
    const run = await ctx.plugins.start(id, args)
    const done = await ctx.plugins.wait(run.run_id)
    if (done.status !== 'succeeded') throw new Error(`${id}: ${done.error ?? done.status}`)
    return done.result
  }

  let opened = false
  try {
    const open = await runAndWait('core.open_block', {
      block: 'minecraft:chest', range: 4,
    })
    if (open.result !== 'screen_opened') return { result: 'open_failed', evidence: open }
    opened = true

    const stored = await runAndWait('core.container_exchange', {
      deposit: [{ item: 'minecraft:stone', count: ctx.args.count ?? 20 }],
    })
    if (stored.result !== 'transferred') return { result: 'deposit_incomplete', evidence: stored }
    return { result: 'stored', evidence: stored }
  } finally {
    if (opened) await ctx.api.call('container.close', {})
  }
}
```

配置为 once，不能用 enabled 持久挂载。子插件保留界面，父插件负责 finally 关窗；partial/unknown 不冒充全部存入。

## 6. 调试清单

- validate 报路径/manifest/args：先修正，旧挂载不会因非法 submit 改变。
- run 已启动但没效果：查 status、logs、subscriptions、dropped_events 和实际游戏状态。
- 子插件没启动新实例：检查是否已有同 ID 活跃 run，start 会复用它。
- 动作一直等待：检查资源租约和优先级，不要让父插件持锁等待需要同锁的子插件。
- service 不再运行：检查是否非 persistent 已条件完成、超过 maxRestarts、被禁用或被 init 切换。
- 修改 example 没生效：这是预期；实际用户代码必须放在 `scripts/<name>.mjs` 并提交配置。
