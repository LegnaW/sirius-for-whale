import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

function environment (t, { position = () => ({ x: 0, y: 64, z: 0 }), followState = null, craft = null, notify = () => {}, baritoneState = 'running' } = {}) {
  const calls = []
  let moved = false
  let closed = false
  let pendingResult = 0
  let pendingOutput = null
  const screen = craft?.playerGrid ? 'InventoryScreen' : 'CraftingScreen'
  const inventory = { 'minecraft:oak_log': 2, 'minecraft:oak_planks': craft?.initialPlanks ?? 0 }
  const slots = craft ? [
    { index: 0, role: 'result', item: null, count: 0 },
    ...Array.from({ length: craft.playerGrid ? 4 : 9 }, (_, index) => ({ index: index + 1, role: 'crafting', item: null, count: 0 })),
    { index: 10, role: 'player', item: 'minecraft:oak_log', count: 2 },
    { index: 11, role: 'player', item: null, count: 0 },
  ] : []
  const link = {
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'getStats') return { in_game: true, position: position() }
      if (method === 'baritone.goto') { moved = true; return { result: 'started' } }
      if (method === 'baritone.settings' || method === 'baritone.stop') return { result: 'ok' }
      if (method === 'baritone.follow') return {
        result: 'following', target: { uuid: 'player-uuid', name: 'Steve', type: 'minecraft:player' },
      }
      if (method === 'baritone.status') return { state: baritoneState, follow: followState }
      if (method === 'world.query') return { blocks: [{ x: 1, y: 64, z: 0, block: 'minecraft:crafting_table' }] }
      if (method === 'use') return { result: 'screen_opened' }
      if (method === 'inventory') {
        if (pendingOutput && pendingOutput.reads-- === 0) {
          inventory[pendingOutput.item] = (inventory[pendingOutput.item] ?? 0) + pendingOutput.count
          pendingOutput = null
        }
        return { counts: { ...inventory } }
      }
      if (method === 'getGuiState') {
        if (pendingResult && --pendingResult === 0) Object.assign(slots[0], { item: craft.produced, count: 4 })
        return { screen_class: screen, slots: slots.map((slot) => ({ ...slot })) }
      }
      if (method === 'container.transfer') {
        const from = slots.find((slot) => slot.index === params.from_slot)
        const to = slots.find((slot) => slot.index === params.to_slot)
        to.item = from.item
        to.count = params.count
        from.count -= params.count
        if (from.count === 0) from.item = null
        if (slots.filter((slot) => slot.role === 'crafting').some((slot) => slot.item)) {
          pendingResult = craft.resultDelay ? 3 : 1
        }
        return { result: 'transferred' }
      }
      if (method === 'container.clickSlot') {
        const produced = slots[0]
        pendingOutput = { item: produced.item, count: produced.count, reads: craft.resultDelay ? 2 : 0 }
        produced.item = null
        produced.count = 0
        return { result: 'clicked', screen_class: screen, carried_after: { item: null, count: 0 } }
      }
      if (method === 'container.close') { closed = true; return { result: 'closed' } }
      return { result: 'ok' }
    },
    subscribe: async () => ({}),
    onEvent: () => () => {},
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new PluginManager({ registry: new PluginRegistry(), runtime, scheduler, notify })
  t.after(async () => { await manager.dispose(); await runtime.dispose() })
  return {
    manager, scheduler, calls, inventory,
    moved: () => moved, closed: () => closed,
  }
}

test('walk 必定禁止破坏/放置，dig_to 必定允许破坏且取得世界修改租约', async (t) => {
  const { manager, scheduler, calls } = environment(t, { position: () => ({ x: 2, y: 64, z: 0 }) })
  const walk = await manager.start('core.walk', { args: { x: 2, z: 0, allow_break: true, allow_place: true } })
  assert.equal((await manager.wait(walk.run_id, 3000)).result.allow_break, false)
  const walkGoal = calls.find((call) => call.method === 'baritone.goto').params
  assert.equal(walkGoal.allow_break, false)
  assert.equal(walkGoal.allow_place, false)

  const dig = await manager.start('core.dig_to', { args: { x: 2, z: 0, allow_break: false, allow_place: true } })
  for (let index = 0; index < 50 && !scheduler.snapshot().leases.world_edit; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(scheduler.snapshot().leases.world_edit, dig.run_id)
  const done = await manager.wait(dig.run_id, 3000)
  assert.equal(done.result.result, 'arrived')
  assert.equal(done.result.allow_break, true)
  assert.equal(done.result.allow_place, false)
  const digGoal = calls.filter((call) => call.method === 'baritone.goto').at(-1).params
  assert.equal(digGoal.allow_break, true)
  assert.equal(digGoal.allow_place, false)
})

test('dig_to 正在执行挖掘时不会在 4.5 秒误判 no_progress', async (t) => {
  const startedAt = Date.now()
  const { manager } = environment(t, {
    baritoneState: 'pathing',
    position: () => Date.now() - startedAt < 6000
      ? { x: 0, y: 64, z: 0 }
      : { x: 3, y: 64, z: 0 },
  })
  const run = await manager.start('core.dig_to', { args: { x: 3, z: 0, timeout_ms: 10000 } })
  const done = await manager.wait(run.run_id, 9000)
  assert.equal(done.result.result, 'arrived')
  assert.ok(done.result.elapsed_ms >= 5000)
})

test('core.follow 目标丢失后停止、恢复设置并通知', async (t) => {
  const notices = []
  const { manager, calls } = environment(t, { followState: { active: false, targets: [] }, notify: (text) => notices.push(text) })
  const run = await manager.start('core.follow', { args: { name: 'Steve' } })
  const done = await manager.wait(run.run_id, 5000)
  assert.equal(done.result.result, 'lost')
  assert.equal(done.result.target.name, 'Steve')
  assert.equal(done.result.follow_radius, 10)
  assert.equal(calls.some((call) => call.method === 'baritone.stop'), true)
  assert.equal(calls.filter((call) => call.method === 'baritone.settings').at(-1).params.allow_break, false)
  assert.ok(notices.some((text) => text.includes('follow lost')))
})

test('core.follow 持续无进展时报告 blocked，不冒充到达', async (t) => {
  const { manager } = environment(t, {
    followState: { active: true, targets: [{ uuid: 'player-uuid', distance: 20 }] },
  })
  const run = await manager.start('core.follow', { args: { uuid: 'player-uuid', follow_radius: 2 } })
  const done = await manager.wait(run.run_id, 9000)
  assert.equal(done.result.result, 'blocked')
  assert.equal(done.result.distance, 20)
})

test('core.craft 按明确配方合成并核对背包增量，结束后关窗', async (t) => {
  const { manager, calls, inventory, closed } = environment(t, { craft: { produced: 'minecraft:oak_planks' } })
  const run = await manager.start('core.craft', {
    args: { grid: ['oak_log', null, null, null], result: 'oak_planks', count: 1 },
  })
  const done = await manager.wait(run.run_id, 3000)
  assert.equal(done.status, 'succeeded', JSON.stringify(done))
  assert.equal(done.result.result, 'crafted')
  assert.equal(done.result.produced, 4)
  assert.equal(inventory['minecraft:oak_planks'], 4)
  assert.equal(calls.some((call) => call.method === 'container.transfer'
    && call.params.from_slot === 10 && call.params.to_slot === 1), true)
  assert.equal(closed(), true)
})

test('core.craft 在背包 2×2 等待结果及库存回执，只取一次并保留界面', async (t) => {
  const { manager, calls, inventory, closed } = environment(t, {
    craft: { playerGrid: true, resultDelay: true, produced: 'minecraft:oak_planks' },
  })
  const run = await manager.start('core.craft', {
    args: { station: 'inventory', grid: [null, null, null, 'oak_log'], result: 'oak_planks' },
  })
  const done = await manager.wait(run.run_id, 4000)
  assert.equal(done.result.result, 'crafted')
  assert.equal(inventory['minecraft:oak_planks'], 4)
  assert.equal(calls.find(call => call.method === 'container.transfer').params.to_slot, 4)
  assert.equal(calls.filter(call => call.method === 'container.clickSlot').length, 1)
  assert.equal(calls.some(call => ['world.query', 'use'].includes(call.method)), false)
  assert.equal(closed(), false)
})

test('core.craft 缺料时不动工作台，结果不符时关窗清理', async (t) => {
  const missing = environment(t, { craft: { produced: 'minecraft:oak_planks' } })
  const missingRun = await missing.manager.start('core.craft', {
    args: { grid: ['oak_log', 'oak_log', null, null], result: 'oak_planks', count: 2 },
  })
  const missingDone = await missing.manager.wait(missingRun.run_id, 2000)
  assert.equal(missingDone.result.result, 'missing_ingredients')
  assert.equal(missing.calls.some((call) => call.method === 'use'), false)

  const mismatch = environment(t, { craft: { produced: 'minecraft:oak_button' } })
  const mismatchRun = await mismatch.manager.start('core.craft', {
    args: { grid: ['oak_log', null, null, null], result: 'oak_planks' },
  })
  const mismatchDone = await mismatch.manager.wait(mismatchRun.run_id, 4500)
  assert.equal(mismatchDone.result.result, 'result_mismatch')
  assert.equal(mismatchDone.result.actual, 'minecraft:oak_button')
  assert.equal(mismatch.closed(), true)
})

test('core.craft 从 checkpoint 续做剩余批次并拒绝产物冲突', async (t) => {
  const resumed = environment(t, { craft: { produced: 'minecraft:oak_planks', initialPlanks: 4 } })
  const run = await resumed.manager.start('core.craft', {
    args: {
      grid: ['oak_log', null, null, null], result: 'oak_planks', count: 2,
      resume_from: 'run_previous',
      resume_checkpoint: { completed: 1, result_item: 'minecraft:oak_planks', inventory_after: 4 },
    },
  })
  const done = await resumed.manager.wait(run.run_id, 3000)
  assert.equal(done.result.result, 'crafted')
  assert.equal(done.result.batches, 1)
  assert.equal(done.result.inventory_after, 8)
  assert.equal(done.checkpoint.completed, 2)

  const conflict = environment(t, { craft: { produced: 'minecraft:oak_planks', initialPlanks: 0 } })
  const conflictRun = await conflict.manager.start('core.craft', {
    args: {
      grid: ['oak_log', null, null, null], result: 'oak_planks', count: 2,
      resume_checkpoint: { completed: 1, result_item: 'minecraft:oak_planks', inventory_after: 4 },
    },
  })
  const conflictDone = await conflict.manager.wait(conflictRun.run_id, 2000)
  assert.equal(conflictDone.result.result, 'resume_conflict')
  assert.equal(conflict.calls.some((call) => call.method === 'use'), false)
})
