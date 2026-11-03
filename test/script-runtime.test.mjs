import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptRuntime } from '../src/script/runtime.mjs'
import { eventMatches, normalizeEventFilter } from '../src/script/contracts.mjs'

function makeLink () {
  const calls = []
  const listeners = new Set()
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'getStats') return { in_game: true, health: 17, food: 18 }
      if (method === 'block.get') return { status: 'ok', block: 'minecraft:oak_door' }
      return { method, params }
    },
    subscribe: async (types) => {
      calls.push({ method: 'events.subscribe', params: { types } })
      return { subscribed: true, types }
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (record) => {
      for (const listener of listeners) listener({ timestamp: 1, seq: 1, ...record })
    },
    listenerCount: () => listeners.size,
  }
}

function runtimeFor (t, { config = {}, canControl } = {}) {
  const link = makeLink()
  const runtime = new ScriptRuntime({ link, canControl, config })
  t.after(() => runtime.dispose())
  return { runtime, link }
}

async function until (predicate, message = 'condition') {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时：${message}`)
}

test('后台脚本真实执行只读 RPC、日志、checkpoint 与返回值', async (t) => {
  const { runtime, link } = runtimeFor(t)
  const started = runtime.start({
    owner: 'owner',
    args: { suffix: 'ok' },
    code: `export default async function(ctx) {
      ctx.state.seen = true
      await ctx.log('started')
      await ctx.checkpoint({ step: 1 })
      const stats = await ctx.api.call('getStats', {})
      await ctx.sleep(20)
      return { health: stats.health, suffix: ctx.args.suffix, state: ctx.state.seen }
    }`,
  })
  assert.ok(started.run_id)
  assert.ok(['queued', 'running'].includes(started.status))
  const done = await runtime.waitFor(started.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.result, { health: 17, suffix: 'ok', state: true })
  assert.deepEqual(done.checkpoint, { step: 1 })
  assert.equal(done.outcome, null)
  assert.equal(runtime.logs(started.run_id)[0].text, 'started')
  assert.equal(link.calls.filter((call) => call.method === 'getStats').length, 1)
})

test('写动作被拒绝，Worker 没有 require/process/timers', async (t) => {
  const { runtime, link } = runtimeFor(t)
  const denied = await runtime.waitFor(runtime.start({
    code: 'export default async function(ctx) { return ctx.api.call("dig", {x:1,y:2,z:3}) }',
  }).run_id, 2000)
  assert.equal(denied.status, 'failed')
  assert.match(denied.error, /只读脚本不允许调用 dig/)
  assert.equal(link.calls.some((call) => call.method === 'dig'), false)

  const isolated = await runtime.waitFor(runtime.start({
    code: `export default async function(ctx) {
      return { require: typeof require, process: typeof process, timer: typeof setTimeout, global: typeof global }
    }`,
  }).run_id, 2000)
  assert.equal(isolated.status, 'succeeded')
  assert.deepEqual(isolated.result, { require: 'undefined', process: 'undefined', timer: 'undefined', global: 'undefined' })
})

test('run 立即返回，同步死循环在 deadline 被强制终止', async (t) => {
  const { runtime } = runtimeFor(t)
  const before = Date.now()
  const started = runtime.start({ code: 'export default async function(ctx) { while (true) {} }', timeout_ms: 100 })
  assert.ok(Date.now() - before < 500)
  const done = await runtime.waitFor(started.run_id, 2000)
  assert.equal(done.status, 'timed_out')
  assert.equal(done.outcome, 'unknown')
  assert.equal(done.error, 'deadline_exceeded')
})

test('stop 取消长时间 sleep，并清空订阅', async (t) => {
  const { runtime } = runtimeFor(t)
  const started = runtime.start({
    code: `export default async function(ctx) {
      const events = await ctx.events.subscribe({types:['held_item_changed']})
      await ctx.sleep(100000)
      return events
    }`,
  })
  await until(() => runtime.get(started.run_id).subscriptions.length === 1)
  const stopped = await runtime.stop(started.run_id)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.outcome, 'unknown')
  assert.equal(stopped.subscriptions.length, 0)
})

test('事件过滤与异步迭代联动，返回真实事件证据', async (t) => {
  const { runtime, link } = runtimeFor(t)
  const started = runtime.start({
    code: `export default async function(ctx) {
      const events = await ctx.events.subscribe({types:['entity_death'], uuid:'target'})
      const next = await events.next()
      return next.value.data
    }`,
  })
  await until(() => runtime.get(started.run_id).subscriptions.length === 1)
  link.emit({ event: 'entity_death', data: { uuid: 'other', type: 'minecraft:cow' } })
  link.emit({ event: 'entity_death', data: { uuid: 'target', type: 'minecraft:cow', health: 0 } })
  const done = await runtime.waitFor(started.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.uuid, 'target')
  assert.equal(done.result.health, 0)
  assert.equal(done.subscriptions.length, 0)
})

test('连接侧事件队列有界，溢出计数且不静默', async (t) => {
  const { runtime, link } = runtimeFor(t, { config: { eventQueueSize: 2 } })
  const started = runtime.start({
    code: `export default async function(ctx) {
      await ctx.events.subscribe({types:['block_update']})
      await ctx.sleep(100000)
    }`,
  })
  await until(() => runtime.get(started.run_id).subscriptions.length === 1)
  for (let i = 0; i < 5; i++) link.emit({ event: 'block_update', data: { x: i } })
  const current = runtime.get(started.run_id)
  assert.equal(current.dropped_events, 3)
  assert.equal(current.subscriptions[0].queued, 2)
  assert.ok(runtime.logs(started.run_id).some((entry) => entry.text.includes('事件队列已满')))
  await runtime.stop(started.run_id)
  link.emit({ event: 'block_update', data: { x: 6 } })
  assert.equal(runtime.get(started.run_id).dropped_events, 3)
})

test('init 接管使旧 run 全部失效，所有权变化后不能继续 RPC', async (t) => {
  let allowed = true
  const { runtime, link } = runtimeFor(t, { canControl: () => allowed })
  const stopped = runtime.start({ code: 'export default async function(ctx) { await ctx.sleep(100000) }' })
  await runtime.retireAll('sirius_init')
  assert.equal(runtime.get(stopped.run_id).status, 'cancelled')

  allowed = false
  const denied = runtime.start({ code: 'export default async function(ctx) { return ctx.api.call("getStats", {}) }' })
  const done = await runtime.waitFor(denied.run_id, 2000)
  assert.equal(done.status, 'failed')
  assert.match(done.error, /身体所有权已变更/)
  assert.equal(link.calls.some((call) => call.method === 'getStats'), false)
})

test('事件过滤支持嵌套 uuid、物品、方块与维度', () => {
  const filter = normalizeEventFilter({ types: ['block_update'], block: 'minecraft:oak_door', dimension: 'minecraft:overworld' })
  assert.equal(eventMatches(filter, { event: 'block_update', data: { dimension: 'minecraft:overworld', after: { block: 'minecraft:oak_door' } } }), true)
  assert.equal(eventMatches(filter, { event: 'block_update', data: { dimension: 'minecraft:overworld', after: { block: 'minecraft:stone' } } }), false)
  assert.throws(() => normalizeEventFilter({ types: 'chat' }), /数组/)
  assert.throws(() => normalizeEventFilter({ types: [], arbitrary: true }), /不支持/)
})

test('日志环形裁剪后序号仍单调递增', async (t) => {
  const { runtime } = runtimeFor(t, { config: { maxLogs: 2 } })
  const started = runtime.start({
    code: 'export default async function(ctx) { for (let i=0;i<4;i++) await ctx.log("line-"+i); return true }',
  })
  await runtime.waitFor(started.run_id, 2000)
  const logs = runtime.logs(started.run_id)
  assert.deepEqual(logs.map((entry) => entry.text), ['line-2', 'line-3'])
  assert.ok(logs[0].index < logs[1].index)
  assert.equal(runtime.logs(started.run_id, { since: logs[0].index + 1 }).length, 1)
})
