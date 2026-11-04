import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

function environment (t, { position = () => ({ x: 0, y: 64, z: 0 }), baritone = {}, workspace = null, notify = () => {}, onCall = () => {} } = {}) {
  const calls = []
  const link = {
    call: async (method, params) => {
      calls.push({ method, params })
      const override = onCall(method, params)
      if (override !== undefined) return override
      if (method === 'getStats') return { in_game: true, position: position() }
      if (method === 'baritone.status') return { state: 'idle', ...baritone }
      if (method === 'input.mouseMove') return params.x === 100
        ? { gui_scaled: { x: 50, y: 50 } }
        : { gui_scaled: { x: params.x / 2, y: params.y / 2 } }
      if (method === 'screenshot') return {
        image_b64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
        format: 'png', width: 1, height: 1,
      }
      if (method === 'world.query') return { blocks: [{ x: 1, y: 64, z: 0, block: 'minecraft:oak_door' }] }
      if (method === 'inventory.drop') return {
        in_game: true, result: 'dropped', slot: params.slot, item: 'minecraft:oak_log',
        requested: params.count ?? 5, dropped: params.count ?? 5, before: 10,
        remaining: 10 - (params.count ?? 5), evidence: 'client_snapshot',
      }
      if (method === 'use') return { result: 'used' }
      return { result: 'ok', method, params }
    },
    subscribe: async () => ({}),
    onEvent: () => () => {},
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new PluginManager({
    registry: new PluginRegistry(), runtime, scheduler,
    workspace: typeof workspace === 'function' ? workspace : () => workspace,
    notify,
  })
  t.after(async () => { await manager.dispose(); await runtime.dispose() })
  return { manager, runtime, scheduler, calls }
}

test('core.input 支持键名和 GUI 坐标换算，count/hold 互斥', async (t) => {
  const { manager, calls } = environment(t)
  const key = await manager.start('core.input', { args: { key: 'E' } })
  assert.equal((await manager.wait(key.run_id, 2000)).result.result, 'key_sent')
  assert.equal(calls.find((call) => call.method === 'input.key').params.code, 69)

  const click = await manager.start('core.input', { args: { click: { at: { x: 10, y: 20 }, button: 'left' } } })
  assert.equal((await manager.wait(click.run_id, 2000)).result.result, 'clicked')
  const move = calls.filter((call) => call.method === 'input.mouseMove').at(-1)
  assert.deepEqual(move.params, { x: 20, y: 40 })

  const invalid = await manager.start('core.input', { args: { click: { count: 2, hold_ms: 10 } } })
  assert.equal((await manager.wait(invalid.run_id, 2000)).status, 'failed')
})

test('core.input 在协议 1.13 直接发送 GUI 坐标', async (t) => {
  const { manager, calls } = environment(t, {
    onCall: (method) => method === 'capabilities/list' ? { protocol_version: '1.13' } : undefined,
  })
  const at = { x: 10.5, y: 20 }
  const click = await manager.start('core.input', { args: { click: { at, button: 'right' } } })
  assert.equal((await manager.wait(click.run_id, 2000)).result.result, 'clicked')
  assert.deepEqual(calls.filter(({ method }) => method.startsWith('input.')), [
    { method: 'input.click', params: { button: 1, count: 1, at } },
  ])
})

test('库存内置按实际菜单槽搬运，跨槽存取，读回异常时停止', async (t) => {
  const stone = 'minecraft:cobblestone'
  const iron = 'minecraft:iron_ingot'
  const stack = (item, count) => ({ item, count })
  const slots = [
    { index: 0, container_slot: 0, role: 'container', ...stack(null, 0) },
    { index: 1, container_slot: 1, role: 'container', ...stack(iron, 9) },
    { index: 27, container_slot: 9, role: 'player', ...stack(stone, 13) },
    { index: 28, container_slot: 10, role: 'player', ...stack(stone, 10) },
    { index: 54, container_slot: 0, role: 'hotbar', ...stack(null, 0) },
  ]
  let open = true
  let supported = true
  let closeAfterTransfer = false
  const screenClass = 'ModdedStorageScreen'
  const { manager, scheduler, calls } = environment(t, { onCall (method, params) {
    if (method === 'capabilities/list') return { capabilities: supported ? [{ name: 'container.transfer' }] : [] }
    if (method === 'getGuiState') {
      assert.ok(scheduler.snapshot().leases.inventory)
      return open ? { screen_open: true, screen_class: screenClass, slots } : { screen_open: false }
    }
    if (method !== 'container.transfer') return
    const { from_slot, to_slot, count } = params
    const from = slots.find(slot => slot.index === from_slot)
    const to = slots.find(slot => slot.index === to_slot)
    assert.ok(from.count >= count && (!to.item || to.item === from.item))
    const before = [stack(from.item, from.count), stack(to.item, to.count)]
    to.item = from.item
    to.count += count
    from.count -= count
    if (!from.count) from.item = null
    if (closeAfterTransfer) open = false
    return {
      result: 'transferred', screen_class: screenClass, container_id: 4, moved: count,
      changed_slots: [from, to].map((slot, index) => ({
        slot: slot.index, before: before[index], after: stack(slot.item, slot.count),
      })),
    }
  } })
  const run = async (id, args) => {
    const started = await manager.start(id, { args })
    const finished = await manager.wait(started.run_id, 4000)
    assert.equal(finished.status, 'succeeded', finished.error)
    return finished.result
  }
  const exchange = { deposit: [{ item: stone, count: 20 }], withdraw: [{ item: iron, count: 5 }] }
  const result = await run('core.container_exchange', exchange)
  assert.equal(result.result, 'transferred')
  assert.deepEqual(result.operations.map(entry => entry.moved), [20, 5])
  assert.deepEqual(slots.map(slot => slot.count), [20, 4, 5, 3, 0])
  assert.equal(result.evidence, 'client_snapshot')
  const partial = await run('core.container_exchange', {
    deposit: [{ item: stone, count: 1 }], withdraw: [{ item: iron, count: 10 }],
  })
  assert.equal(partial.result, 'partial')
  assert.deepEqual(partial.operations.map(entry => entry.moved), [1, 0])
  const move = { from_slot: 10, to_slot: 0 }
  assert.equal((await run('core.inventory_move', move)).moved, 2)
  assert.deepEqual(calls.filter(call => call.method === 'container.transfer').at(-1).params,
    { from_slot: 28, to_slot: 54, count: 2 })
  closeAfterTransfer = true
  const uncertain = await run('core.inventory_move', { from_slot: 0, to_slot: 10, count: 1 })
  assert.equal(uncertain.result, 'window_changed')
  assert.equal(uncertain.moved, 0)
  assert.equal((await run('core.inventory_move', move)).result, 'no_container')
  supported = false
  assert.equal((await run('core.inventory_move', move)).result, 'unsupported_bridge')
  assert.equal(scheduler.snapshot().leases.inventory, undefined)
  assert.equal(calls.some(call => ['use', 'input.key', 'container.close'].includes(call.method)), false)
})

test('core.drop 透传槽位和可选数量，走动作层并释放 inventory 租约', async (t) => {
  const { manager, calls, scheduler } = environment(t)
  assert.deepEqual(scheduler.resourcesFor('inventory.drop'), ['inventory'])
  const partial = await manager.start('core.drop', { args: { slot: 8, count: 3 } })
  const dropped = await manager.wait(partial.run_id, 2000)
  assert.equal(dropped.status, 'succeeded')
  assert.equal(dropped.result.result, 'dropped')
  assert.equal(dropped.result.dropped, 3)
  assert.equal(dropped.result.remaining, 7)
  assert.deepEqual(calls.find((call) => call.method === 'inventory.drop').params, { slot: 8, count: 3 })

  const whole = await manager.start('core.drop', { args: { slot: 9 } })
  assert.equal((await manager.wait(whole.run_id, 2000)).result.dropped, 5)
  assert.deepEqual(calls.filter((call) => call.method === 'inventory.drop').at(-1).params, { slot: 9 })
  assert.equal(calls.some((call) => call.method === 'input.key'), false)
  assert.equal(scheduler.snapshot().leases.inventory, undefined)
})

test('core.screenshot 只写工作区并返回路径，不回传 base64', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'sirius-shot-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { manager } = environment(t, { workspace })
  const run = await manager.start('core.screenshot', { args: { tier: 'full' } })
  const done = await manager.wait(run.run_id, 2000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.result, 'saved')
  assert.equal(done.result.image_b64, undefined)
  const bytes = await readFile(done.result.path)
  assert.deepEqual([...bytes], [137, 80, 78, 71, 13, 10, 26, 10])
})

test('core.walk 到位后复核停稳位置并恢复安全设置', async (t) => {
  let moved = false
  const notices = []
  const { manager, calls } = environment(t, {
    position: () => moved ? { x: -0.2, y: 65, z: 0.5 } : { x: -0.2, y: 64, z: 0.5 },
    notify: (text) => notices.push(text),
    onCall: (method) => { if (method === 'baritone.goto') moved = true },
  })
  const run = await manager.start('core.walk', { args: { x: -0.2, y: 65, z: 0.5, timeout_ms: 5000 } })
  const done = await manager.wait(run.run_id, 3000)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.result, 'arrived')
  assert.deepEqual(done.result.settled, { x: -0.2, y: 65, z: 0.5 })
  assert.deepEqual(calls.find(call => call.method === 'baritone.goto').params, { x: -1, y: 65, z: 0, allow_break: false, allow_place: false })
  assert.equal(calls.some((call) => call.method === 'baritone.stop'), true)
  assert.equal(calls.filter((call) => call.method === 'baritone.settings').at(-1).params.allow_break, false)
  assert.ok(notices.some((text) => text.includes('walk arrived')))
})

test('core.walk 区分 no_path，不误报为到达', async (t) => {
  const { manager } = environment(t, { baritone: { state: 'no_path', last_line: 'CALC_FAILED' } })
  const run = await manager.start('core.walk', { args: { x: 5, z: 0, timeout_ms: 5000 } })
  const done = await manager.wait(run.run_id, 7000)
  assert.equal(done.result.result, 'no_path')
  assert.equal(done.result.reason, 'CALC_FAILED')
})

test('core.walk 卡住时开门并重试', async (t) => {
  let opened = false
  let evaluations = 0
  const { manager, calls } = environment(t, {
    position: () => opened ? { x: 5, y: 64, z: 0 } : evaluations++ === 0 ? { x: 0, y: 64, z: 0 } : { x: 1, y: 64, z: 0 },
    onCall: (method) => { if (method === 'use') opened = true },
  })
  const run = await manager.start('core.walk', { args: { x: 5, z: 0, timeout_ms: 7000 } })
  const done = await manager.wait(run.run_id, 9000)
  assert.equal(done.result.result, 'arrived', JSON.stringify(done))
  assert.equal(done.result.opened, true)
  assert.equal(calls.some((call) => call.method === 'use'), true)
})

test('core.walk 被高优先级抢占时停止任务与 Baritone', async (t) => {
  const { manager, scheduler, calls } = environment(t)
  manager.create({ id: 'user.interrupt', code: 'export default async function(ctx) { return ctx.api.call("baritone.goto",{x:9,z:9}) }', manifest: { priority: 80 } })
  const walk = await manager.start('core.walk', { args: { x: 5, z: 0, timeout_ms: 5000 } })
  for (let i = 0; i < 50 && scheduler.snapshot().leases.movement !== walk.run_id; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const high = await manager.start('user.interrupt')
  assert.equal((await manager.wait(high.run_id, 2000)).status, 'succeeded')
  assert.equal((await manager.status(walk.run_id)).status, 'preempted')
  assert.equal(calls.filter((call) => call.method === 'baritone.stop').length >= 1, true)
})
