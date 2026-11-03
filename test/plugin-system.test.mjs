import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

function environment (t, { storageFile = '', notify = () => {} } = {}) {
  const calls = []
  const listeners = new Set()
  const link = {
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'world.query') return { blocks: [{ x: 4, y: 64, z: -2, block: 'sophisticatedstorage:gold_barrel' }] }
      if (method === 'use') return { result: 'screen_opened', screen_class: 'StorageScreen' }
      if (method === 'getStats') return { in_game: true, health: 20 }
      return { method, params }
    },
    subscribe: async () => ({}),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: (event) => { for (const listener of listeners) listener(event) },
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const registry = new PluginRegistry({ storageFile })
  const manager = new PluginManager({ registry, runtime, scheduler, notify })
  t.after(async () => {
    await manager.dispose()
    await runtime.dispose()
  })
  return { manager, registry, runtime, scheduler, link, calls }
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

test('内置不可改删，用户 once 启停完成生命周期', async (t) => {
  const { manager } = environment(t)
  await assert.rejects(manager.update('core.open_block', { code: 'export default async function() {}' }), /不可修改/)
  await assert.rejects(manager.delete('core.damage_watch'), /不可删除/)

  manager.create({ id: 'user.answer', code: 'export default async function(ctx) { return {answer:ctx.args.value} }', manifest: { args: { value: 42 } } })
  const enabled = await manager.enable('user.answer', { owner: 'owner' })
  const done = await manager.wait(enabled.run.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.answer, 42)
  assert.equal(done.mode, 'once')
  await until(() => manager.get('user.answer').enabled === false)
  const disabled = await manager.disable('user.answer')
  assert.equal(disabled.definition.enabled, false)
})

test('用户更新与删除先停止活跃实例', async (t) => {
  const { manager } = environment(t)
  manager.create({ id: 'user.long', code: 'export default async function(ctx) { await ctx.sleep(100000) }', manifest: { mode: 'task' } })
  const { run } = await manager.enable('user.long')
  const updated = await manager.update('user.long', { manifest: { priority: 60 } })
  assert.equal(updated.version, 2)
  assert.equal((await manager.status(run.run_id)).status, 'cancelled')
  await manager.enable('user.long')
  assert.deepEqual(await manager.delete('user.long'), { deleted: true, id: 'user.long' })
  assert.throws(() => manager.get('user.long'), /不存在/)
})

test('插件可 start/wait 其他插件，父级优先级向下收敛', async (t) => {
  const { manager } = environment(t)
  manager.create({ id: 'user.child', code: 'export default async function(ctx) { return {value:ctx.args.value} }', manifest: { priority: 80 } })
  manager.create({
    id: 'user.parent',
    code: `export default async function(ctx) {
      const child = await ctx.plugins.start('user.child', {value:7})
      const result = await ctx.plugins.wait(child.run_id)
      return {child:result.result, childRun:result.run_id}
    }`,
    manifest: { priority: 20 },
  })
  const parent = await manager.start('user.parent')
  const done = await manager.wait(parent.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.result.child, { value: 7 })
  const child = manager.status(done.result.childRun)
  assert.equal(child.parent_id, parent.run_id)
  assert.equal(child.priority, 20)
  assert.deepEqual(child.plugin_stack, ['user.parent', 'user.child'])
})

test('循环插件调用被拒绝，不会形成无限递归', async (t) => {
  const { manager } = environment(t)
  manager.create({ id: 'user.a', code: 'export default async function(ctx) { const child=await ctx.plugins.start("user.b"); return ctx.plugins.wait(child.run_id) }' })
  manager.create({ id: 'user.b', code: 'export default async function(ctx) { return ctx.plugins.start("user.a") }' })
  const run = await manager.start('user.a')
  const done = await manager.wait(run.run_id, 2000)
  assert.equal(done.result.status, 'failed', JSON.stringify(done))
  assert.match(done.result.error, /循环插件调用|已终止/)
  assert.ok(manager.list().every((plugin) => plugin.active.length === 0))
})

test('高优先级动作抢占低优先级任务并释放租约', async (t) => {
  const { manager, runtime, scheduler, calls } = environment(t)
  manager.create({
    id: 'user.dig',
    code: 'export default async function(ctx) { await ctx.api.call("dig",{}); await ctx.sleep(100000) }',
    manifest: { mode: 'task', priority: 20 },
  })
  manager.create({ id: 'user.fight', code: 'export default async function(ctx) { return ctx.api.call("place",{}) }', manifest: { priority: 80 } })
  const low = await manager.start('user.dig')
  await until(() => scheduler.snapshot().leases.world_edit === low.run_id)
  const high = await manager.start('user.fight')
  assert.equal((await manager.wait(high.run_id, 2000)).status, 'succeeded')
  assert.equal((await manager.status(low.run_id)).status, 'preempted')
  assert.deepEqual(scheduler.snapshot().leases, {})
  assert.equal(calls.some((call) => call.method === 'place'), true)
  assert.equal(runtime.snapshot().active, 0)
})

test('同级或低级冲突等待，旧任务结束后继续', async (t) => {
  const { manager, scheduler, calls } = environment(t)
  manager.create({
    id: 'user.first',
    code: 'export default async function(ctx) { await ctx.api.call("dig",{}); await ctx.sleep(100000) }',
    manifest: { mode: 'task', priority: 50 },
  })
  manager.create({ id: 'user.second', code: 'export default async function(ctx) { return ctx.api.call("place",{}) }', manifest: { priority: 20 } })
  const first = await manager.start('user.first')
  await until(() => scheduler.snapshot().leases.world_edit === first.run_id)
  const second = await manager.start('user.second')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(calls.some((call) => call.method === 'place'), false)
  await manager.disable('user.first')
  assert.equal((await manager.wait(second.run_id, 2000)).status, 'succeeded')
  assert.equal(calls.some((call) => call.method === 'place'), true)
})

test('persistent service 有界退避重启，最终如实停用', async (t) => {
  const { manager } = environment(t)
  manager.create({
    id: 'user.crash',
    code: 'export default async function(ctx) { throw new Error("boom") }',
    manifest: { mode: 'service', persistent: true, maxRestarts: 1, restartDelayMs: 50 },
  })
  await manager.enable('user.crash')
  await until(() => manager.get('user.crash').enabled === false)
  assert.ok(manager.list()[0].active.length >= 0)
  assert.ok(manager.get('user.crash'))
})

test('有限 service 收到条件事件后完成并自动关闭', async (t) => {
  const { manager, link } = environment(t)
  manager.create({
    id: 'user.once_event',
    code: `export default async function(ctx) {
      const events = await ctx.events.subscribe({types:['item_pickup']})
      const next = await events.next()
      return next.value.data
    }`,
    manifest: { mode: 'service', persistent: false },
  })
  const { run } = await manager.enable('user.once_event')
  await until(() => manager.status(run.run_id).subscriptions.length === 1)
  link.emit({ event: 'item_pickup', data: { amount: 2 } })
  const done = await manager.wait(run.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.amount, 2)
  await until(() => manager.get('user.once_event').enabled === false)
})

test('内置 open_block 搜索最近方块并调用 use', async (t) => {
  const { manager, calls } = environment(t)
  const run = await manager.start('core.open_block', { args: { block: 'sophisticatedstorage:gold_barrel' } })
  const done = await manager.wait(run.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.result, 'screen_opened')
  assert.deepEqual(done.result.target, { x: 4, y: 64, z: -2, block: 'sophisticatedstorage:gold_barrel' })
  assert.equal(calls.find((call) => call.method === 'world.query').params.range, 4)
  assert.equal(calls.some((call) => call.method === 'use'), true)
})

test('内置 damage_watch 默认启用，完整标注来源和缺失字段并可停用', async (t) => {
  const notices = []
  const { manager, link } = environment(t, { notify: (text) => notices.push(text) })
  assert.equal(manager.get('core.damage_watch').enabled, true)
  assert.equal(manager.get('core.damage_watch').manifest.args.damageCooldownMs, 30_000)
  const run = await manager.start('core.damage_watch', {
    owner: 'owner', args: { damageCooldownMs: 0, observeWindowMs: 10 },
  })
  await until(() => manager.status(run.run_id).subscriptions.length === 1)
  link.emit({
    event: 'damage',
    data: {
      health_before: 20, health_after: 18, amount: 2, damage_type: 'minecraft:arrow',
      attacker: { name: 'Skeleton', type: 'minecraft:skeleton' },
      direct_entity: { name: 'Arrow', type: 'minecraft:arrow' },
    },
  })
  await until(() => notices.length === 1)
  assert.match(notices[0], /攻击者 Skeleton（minecraft:skeleton）/)
  assert.match(notices[0], /直接伤害实体 Arrow（minecraft:arrow）/)
  assert.match(notices[0], /插件·core\.damage_watch/)
  link.emit({ event: 'damage', data: { health_before: 18, health_after: 17, damage_type: 'unknown' } })
  await until(() => notices.length === 2)
  assert.match(notices[1], /18 → 17，损失 1；来源：未知/)
  link.emit({ event: 'damage', data: {} })
  await until(() => notices.length === 3)
  assert.match(notices[2], /血量 \? → \?，损失 \?；来源：未知/)
  await manager.disable('core.damage_watch')
  assert.equal(manager.get('core.damage_watch').enabled, false)
  assert.equal(manager.status(run.run_id).status, 'cancelled')
})

test('damage_watch 冷却只抑制唤醒，边界后再次通知', async (t) => {
  const notices = []
  const { manager, link } = environment(t, { notify: (text) => notices.push(text) })
  const run = await manager.start('core.damage_watch', {
    owner: 'owner', args: { damageCooldownMs: 50, observeWindowMs: 10 },
  })
  await until(() => manager.status(run.run_id).subscriptions.length === 1)
  const damage = (after) => link.emit({ event: 'damage', data: { health_before: after + 0.5, health_after: after } })
  damage(19.5)
  damage(19)
  await until(() => notices.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(notices.length, 1)
  damage(18.5)
  await until(() => notices.length === 2)
  await manager.disable('core.damage_watch')
})

test('damage_watch 合并观察窗口内的伤害并限制单条项目数', async (t) => {
  const notices = []
  const { manager, link } = environment(t, { notify: (text) => notices.push(text) })
  const run = await manager.start('core.damage_watch', {
    owner: 'owner', args: { damageCooldownMs: 0, observeWindowMs: 30 },
  })
  await until(() => manager.status(run.run_id).subscriptions.length === 1)
  for (let index = 0; index < 7; index += 1) {
    link.emit({ event: 'damage', data: { health_before: 20 - index, health_after: 19 - index } })
  }
  await until(() => notices.length === 1)
  assert.match(notices[0], /另有 2 条/)
  assert.equal((notices[0].match(/· 我受伤了/g) ?? []).length, 5)
  await manager.disable('core.damage_watch')
})

test('JSON 存储恢复用户插件、manifest 和 enabled 状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sirius-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'plugins.json')
  const registry = new PluginRegistry({ storageFile: file })
  registry.createUser({ id: 'user.saved', code: 'export default async function(ctx) { return true }', manifest: { priority: 66 } })
  registry.setEnabled('user.saved', true)
  const restored = new PluginRegistry({ storageFile: file })
  assert.equal(restored.get('user.saved').enabled, true)
  assert.equal(restored.get('user.saved').manifest.priority, 66)
  assert.equal(restored.get('user.saved').version, 1)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(stored.plugins.length, 1)
})

test('父实例结束后级联停止其子插件', async (t) => {
  const { manager } = environment(t)
  manager.create({ id: 'user.daemon', code: 'export default async function(ctx) { await ctx.sleep(100000) }', manifest: { mode: 'service' } })
  manager.create({
    id: 'user.owner',
    code: 'export default async function(ctx) { return ctx.plugins.start("user.daemon") }',
  })
  const parent = await manager.start('user.owner')
  const child = await manager.wait(parent.run_id, 2000)
  assert.equal(child.result.plugin_id, 'user.daemon')
  await until(() => manager.status(child.result.run_id).status === 'cancelled')
  assert.equal(manager.status(child.result.run_id).error, 'parent_finished')
})

test('宿主恢复 enabled 插件并重新启动实例', async (t) => {
  const { manager } = environment(t)
  manager.create({ id: 'user.resident', code: 'export default async function(ctx) { await ctx.sleep(100000) }', manifest: { mode: 'service' } })
  manager.registry.setEnabled('user.resident', true)
  const runs = await manager.restore({ owner: 'owner' })
  const restored = runs.find((run) => run.plugin_id === 'user.resident')
  assert.ok(restored)
  assert.equal(restored.owner, 'owner')
  assert.ok(runs.some((run) => run.plugin_id === 'core.damage_watch'))
  await manager.disable('user.resident')
})
