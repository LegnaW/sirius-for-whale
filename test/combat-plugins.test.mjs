import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

function environment (t, { attacks = [], health = 20, tunnel = null, override = () => {} } = {}) {
  const calls = []
  const listeners = new Set()
  const link = {
    call: async (method, params) => {
      calls.push({ method, params })
      const response = override(method, params)
      if (response !== undefined) return response
      if (method === 'entity.attack') return attacks.length ? attacks.shift() : { result: 'hit', hits: 1 }
      if (method === 'getStats') return {
        in_game: true, health, yaw: 90, position: { x: 0, y: 64, z: 0 },
      }
      if (method === 'baritone.tunnel') return { result: 'started', operation_id: 7, direction: 'west' }
      if (method === 'baritone.status') return { tunnel }
      return { result: 'ok' }
    },
    subscribe: async () => ({}),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: (event) => { for (const listener of listeners) listener(event) },
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new PluginManager({ registry: new PluginRegistry(), runtime, scheduler, notify: () => {} })
  t.after(async () => { await manager.dispose(); await runtime.dispose() })
  return { manager, runtime, scheduler, link, calls }
}

async function until (predicate) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

const zombie = { uuid: '12345678-abcd-1234-abcd-123456789abc', type: 'minecraft:zombie', health: 20 }
const engageCapabilities = ['world.query', 'getStats', 'baritone.goto', 'baritone.stop', 'entity.attack']
  .map(name => ({ name }))

test('core.engage 接近移动的敌人，停步后锁定攻击，受击后重新检查血量', async (t) => {
  let scan = 0
  let health = 20
  const { manager, scheduler, calls } = environment(t, { override (method, params) {
    if (method === 'capabilities/list') return { capabilities: engageCapabilities }
    if (method === 'getStats') return { in_game: true, health, position: { x: 0, y: 64, z: 0 } }
    if (method === 'world.query') {
      assert.equal(scheduler.snapshot().leases.combat, scheduler.snapshot().leases.movement)
      assert.ok(scheduler.snapshot().leases.combat)
      return { entities: [
        { ...zombie, type: 'minecraft:player', uuid: 'other', position: { x: 1, y: 64, z: 0 } },
        { ...zombie, position: { x: [6, 5, 2, 2][Math.min(scan++, 3)], y: 64, z: 0 } },
      ] }
    }
    if (method === 'baritone.goto') {
      assert.equal(params.allow_break, false)
      assert.equal(params.allow_place, false)
      return { result: 'started' }
    }
    if (method === 'baritone.stop') return { result: 'stopped' }
    if (method === 'entity.attack') {
      assert.equal(params.uuid, zombie.uuid)
      health = 7
      return { result: 'hit', hits: 1 }
    }
  } })
  const run = await manager.start('core.engage')
  const done = await manager.wait(run.run_id, 4000)
  assert.equal(done.result.result, 'low_health')
  assert.equal(done.result.hits, 1)
  assert.deepEqual(calls.filter(call => ['baritone.goto', 'baritone.stop', 'entity.attack'].includes(call.method))
    .map(call => call.method), ['baritone.goto', 'baritone.goto', 'baritone.stop', 'entity.attack'])
  assert.deepEqual(scheduler.snapshot().leases, {})
})

test('core.engage 被围不攻击，取消追击会向桥发送 stop 并释放租约', async (t) => {
  let surrounded = true
  const { manager, runtime, scheduler, calls } = environment(t, { override (method) {
    if (method === 'capabilities/list') return engageCapabilities
    if (method === 'world.query') return { entities: surrounded
      ? [1, 2, 3].map(n => ({ ...zombie, uuid: zombie.uuid.slice(0, -1) + n, position: { x: n, y: 64, z: 0 } }))
      : [{ ...zombie, position: { x: 7, y: 64, z: 0 } }] }
    if (method === 'baritone.goto') return { result: 'started' }
    if (method === 'baritone.stop') return { result: 'stopped' }
  } })
  const blocked = await manager.start('core.engage')
  assert.equal((await manager.wait(blocked.run_id, 2000)).result.result, 'surrounded')
  surrounded = false
  const active = await manager.start('core.engage', { args: { uuid: zombie.uuid } })
  await until(() => calls.some(call => call.method === 'baritone.goto'))
  assert.equal((await runtime.stop(active.run_id, 'sirius_stop')).status, 'cancelled')
  assert.equal(calls.at(-1).method, 'baritone.stop')
  assert.equal(calls.some(call => call.method === 'entity.attack'), false)
  assert.deepEqual(scheduler.snapshot().leases, {})
})

test('core.attack hits 透传连击参数，dead 锁定首次 UUID 并汇总', async (t) => {
  const { manager, calls } = environment(t, {
    attacks: [
      { result: 'hit', hits: 3 },
      { result: 'hit', hits: 1, entity: { uuid: 'z-1', name: 'Zombie', health: 1 } },
      { result: 'dead', hits: 1, entity: { uuid: 'z-1', name: 'Zombie', health: 0 } },
    ],
  })
  const single = await manager.start('core.attack', { args: { uuid: 'z-1', count: 3, until: 'hits' } })
  await manager.wait(single.run_id, 2000)
  assert.equal(calls[0].params.count, 3)

  const run = await manager.start('core.attack', { args: { name: 'Zombie', until: 'dead', interval_ms: 0 } })
  const done = await manager.wait(run.run_id, 3000)
  assert.equal(done.result.result, 'dead')
  assert.equal(done.result.attempts, 2)
  assert.equal(done.result.hits, 2)
  const attacks = calls.filter((call) => call.method === 'entity.attack')
  assert.equal(attacks[1].params.name, 'Zombie')
  assert.equal(attacks[2].params.uuid, 'z-1')
  assert.equal(attacks[2].params.name, undefined)
})

test('core.attack 初始低血不会发起攻击', async (t) => {
  const { manager, calls } = environment(t, { health: 6 })
  const run = await manager.start('core.attack', { args: { uuid: 'z-1', until: 'dead', min_health: 8 } })
  const done = await manager.wait(run.run_id, 2000)
  assert.equal(done.result.result, 'low_health')
  assert.equal(calls.some((call) => call.method === 'entity.attack'), false)
})

test('core.tunnel 复核 Builder 终局、保存进度并恢复安全设置', async (t) => {
  const { manager, calls } = environment(t, {
    tunnel: { operation_id: 7, active: false, result: 'done', progress: 3, remaining: 0 },
  })
  const run = await manager.start('core.tunnel', { args: { height: 2, width: 1, depth: 3, timeout_ms: 5000 } })
  const done = await manager.wait(run.run_id, 3000)
  assert.equal(done.result.result, 'done')
  assert.equal(done.result.progress, 3)
  assert.equal(done.checkpoint.operation_id, 7)
  assert.equal(calls.filter((call) => call.method === 'baritone.settings').at(-1).params.allow_break, false)
  assert.equal(calls.some((call) => call.method === 'baritone.stop'), true)
})

test('damage_watch 打断低优先级 task，保留 service，冷却内不重复打断', async (t) => {
  const { manager, link, calls } = environment(t)
  manager.create({ id: 'user.work', code: 'export default async function(ctx) { await ctx.sleep(100000) }', manifest: { mode: 'task', priority: 20 } })
  manager.create({ id: 'user.listener', code: 'export default async function(ctx) { await ctx.sleep(100000) }', manifest: { mode: 'service', priority: 40 } })
  const work = await manager.start('user.work')
  const service = await manager.start('user.listener')
  const damage = await manager.start('core.damage_watch', { args: { observeWindowMs: 10 } })
  await until(() => manager.status(damage.run_id).subscriptions.length === 1)
  link.emit({ event: 'damage', data: { health_before: 20, health_after: 19.5 } })
  await until(() => manager.status(work.run_id).status === 'preempted')
  assert.equal(manager.status(service.run_id).status, 'running')
  assert.equal(calls.some((call) => call.method === 'baritone.stop'), true)
  assert.equal(calls.some((call) => call.method === 'baritone.settings' && call.params.allow_break === false), true)

  const second = await manager.start('user.work')
  link.emit({ event: 'damage', data: { health_before: 19.5, health_after: 19 } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(manager.status(second.run_id).status, 'running')
  await manager.disable('core.damage_watch')
})

test('sirius_init 后 restore 重新启动 enabled 常驻插件并绑定新 owner', async (t) => {
  const { manager } = environment(t)
  const { run } = await manager.enable('core.damage_watch', { owner: 'old-owner' })
  await until(() => manager.status(run.run_id).subscriptions.length === 1)
  await manager.runtime.retireAll('sirius_init')
  assert.equal(manager.get('core.damage_watch').active.length, 0)
  assert.equal(manager.get('core.damage_watch').enabled, true)
  await manager.restore({ owner: 'new-owner' })
  const active = manager.get('core.damage_watch').active
  assert.equal(active.length, 1)
  assert.equal(active[0].owner, 'new-owner')
  await until(() => manager.status(active[0].run_id).status === 'running')
  assert.notEqual(active[0].run_id, run.run_id)
})
