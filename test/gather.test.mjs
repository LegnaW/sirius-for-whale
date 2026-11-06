import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gather, gatherArgs } from '../src/plugin/gather.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'

const wood = 'testmod:wood'
const stone = 'minecraft:stone'
const point = (x, y = 64, z = 0) => ({ x, y, z })
const id = p => [p.x, p.y, p.z].join(',')

function fixture ({ args = {}, world = [[point(0), wood], [point(1), stone], [point(2), wood]],
  health = 20, obstacle = false, failSecond = false, unknown = false, drops = false, strict = true, rollback = false } = {}) {
  const blocks = new Map(world.map(([p, block]) => [id(p), block]))
  const calls = []
  let feet = point(-1)
  let gained = 0
  let groundDrop = null
  let api
  const run = () => gather({
    args: { from: point(0), to: point(2), blocks: [wood], ...args },
    sleep: async () => {},
    api: api = { call: async (method, p) => {
      calls.push({ method, p })
      switch (method) {
        case 'capabilities/list':
          return [{ name: 'dig', input_schema: { properties: strict ? { safety_checks: {}, expected_block: {}, auto_tool: {} } : {} } }]
        case 'getStats': return { in_game: true, alive: true, health, position: feet }
        case 'block.get':
          if (unknown && p.x === 2) return { status: 'unloaded', block: null }
          return { status: 'ok', block: blocks.get(id(p)) ?? 'minecraft:air',
            air: !blocks.has(id(p)), passable: !blocks.has(id(p)), breakable: blocks.has(id(p)) }
        case 'baritone.stop': return { result: 'stopped' }
        case 'baritone.status': return { state: 'arrived' }
        case 'baritone.goto':
          feet = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
          if (groundDrop) { gained++; groundDrop = null }
          return { result: 'started' }
        case 'inventory': return { in_game: true, counts: { 'testmod:drop': gained } }
        case 'world.query': return { entities: groundDrop ? [groundDrop] : [], truncated: false }
        case 'dig':
          if (failSecond && gained) throw new Error('dig disconnected')
          assert.equal(p.safety_checks, false)
          assert.equal(p.auto_tool, true)
          if (p.expected_block) assert.equal(p.expected_block, blocks.get(id(p)))
          if (obstacle && blocks.has('1,64,0') && p.x === 0 && p.expected_block) return { result: 'blocked_sight' }
          if (rollback) return { result: 'broken' }
          blocks.delete(id(p))
          if (drops) groundDrop = { uuid: 'drop-' + p.x, item: 'testmod:drop', count: 1, position: center(p) }
          else gained++
          return { result: 'broken' }
        default: throw new Error(method)
      }
    } },
  })
  return { run, calls, blocks, get api () { return api } }
}
const center = p => ({ x: p.x + 0.5, y: p.y + 0.2, z: p.z + 0.5 })

test('box endpoints are inclusive and order-independent; filtered mod IDs are gathered', async () => {
  const { run, calls } = fixture({ args: { from: point(2), to: point(0) } })
  const result = await run()
  assert.equal(result.result, 'area_exhausted')
  assert.equal(result.mined, 2)
  assert.equal(result.region.volume, 3)
  assert.deepEqual(result.collected, { 'testmod:drop': 2 })
  assert.ok(calls.filter(c => c.method === 'dig').every(c => c.p.expected_block === wood))
})

test('only explicit blocks all collects every breakable block without a default twelve-block cap', async () => {
  const world = Array.from({ length: 14 }, (_, x) => [point(x), x % 2 ? stone : wood])
  const { run } = fixture({ world, args: { from: point(0), to: point(13), blocks: 'all' } })
  const result = await run()
  assert.equal(result.result, 'area_exhausted')
  assert.equal(result.mined, 14)
})

test('allow_other_blocks is explicit and forwarded to pathfinding and occluder-tolerant digging', async () => {
  const { run, calls } = fixture({
    world: [[point(8), wood]], args: { from: point(8), to: point(8), allow_other_blocks: true },
  })
  assert.equal((await run()).mined, 1)
  const movement = calls.find(c => c.method === 'baritone.goto')
  assert.equal(movement.p.allow_break, true)
  assert.equal(movement.p.allow_place, false)
  assert.equal(calls.find(c => c.method === 'dig').p.expected_block, undefined)
})

test('blocked targets are retried after other matching blocks expose them', async () => {
  const { run } = fixture({ obstacle: true, args: { blocks: 'all' } })
  const result = await run()
  assert.equal(result.result, 'area_exhausted')
  assert.equal(result.mined, 3)
  assert.ok(result.rounds >= 2)
  assert.deepEqual(result.skipped, [])
})

test('no progress ends as incomplete and preserves blocked and unknown coordinates', async () => {
  const blocked = fixture({ obstacle: true, unknown: true })
  const result = await blocked.run()
  assert.equal(result.result, 'area_incomplete')
  assert.equal(result.mined, 0)
  assert.ok(result.remaining.length)
  assert.ok(result.scan.unknown.some(p => p.x === 2))
  assert.equal(result.skipped[0].reason, 'blocked_sight')
})

test('optional cap preserves remaining targets; low health no longer adds a script-side refusal', async () => {
  const { run } = fixture({ health: 5, args: { max_blocks: 1 } })
  const result = await run()
  assert.equal(result.result, 'limit_reached')
  assert.equal(result.remaining.length, 1)
  assert.equal(result.mined, 1)
})

test('drop collection verifies inventory gains and reports remaining visible drops', async () => {
  const result = await fixture({ drops: true }).run()
  assert.equal(result.mined, 2)
  assert.deepEqual(result.collected, { 'testmod:drop': 2 })
  assert.deepEqual(result.uncollected, {})
  assert.equal(result.pickup_scan_complete, true)
})

test('RPC failures keep completed harvest and inventory verification', async () => {
  const result = await fixture({ failSecond: true }).run()
  assert.equal(result.result, 'interrupted')
  assert.equal(result.mined, 1)
  assert.deepEqual(result.collected, { 'testmod:drop': 1 })
  assert.equal(result.rpc_error.method, 'dig')
})

test('invalid coordinates, filter, booleans and oversize boxes return field diagnostics before actions', async () => {
  for (const args of [
    { from: { x: '0', y: 64, z: 0 } }, { blocks: ['oak_log'] },
    { allow_other_blocks: 'true' }, { to: point(4096) },
  ]) {
    const { run, calls } = fixture({ args })
    const result = await run()
    assert.equal(result.result, 'invalid_args')
    assert.ok(result.errors[0].field)
    assert.deepEqual(calls, [])
  }
})

test('legacy seed inputs and partial workspace defaults remain accepted', () => {
  const legacy = gatherArgs({ x: 0, y: 64, z: 0, range: 5, blocks: [wood] })
  assert.equal(legacy.legacy, true)
  assert.equal(legacy.volume, 125)
  assert.equal(legacy.limit, 12)
  assert.deepEqual(gatherArgs({ blocks: [wood] }, true).errors, [])
})

test('old Bridges fail before any action with the missing capability identified', async () => {
  const { run, calls } = fixture({ strict: false })
  assert.equal((await run()).required_capability, 'dig.auto_tool')
  assert.deepEqual(calls.map(c => c.method), ['capabilities/list'])
})

test('the registered core.gather runs the shared argument parser inside the Worker', async (t) => {
  const fixtureState = fixture()
  await fixtureState.run()
  fixtureState.blocks.set(id(point(0)), wood)
  const link = { call: fixtureState.api.call, onEvent: () => () => {}, subscribe: async () => ({}) }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new PluginManager({ registry: new PluginRegistry(), runtime, scheduler })
  t.after(async () => { await manager.dispose(); await runtime.dispose() })
  const run = await manager.start('core.gather', { args: { from: point(0), to: point(2), blocks: [wood] } })
  const result = await manager.wait(run.run_id, 3000)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.result.result, 'area_exhausted')
  assert.equal(result.result.mined, 1)
})

test('a broken reply whose target remains present is not counted as harvested', async () => {
  const result = await fixture({ rollback: true }).run()
  assert.equal(result.result, 'area_incomplete')
  assert.equal(result.mined, 0)
  assert.equal(result.remaining.length, 2)
  assert.ok(result.skipped.every(p => p.reason === 'break_unconfirmed'))
})

test('missing, empty and implicit wildcard filters are rejected before any RPC', async () => {
  for (const blocks of [undefined, null, '', ' ', [], ['all'], '*', ['*']]) {
    const { run, calls } = fixture({ args: { blocks, allow_other_blocks: true } })
    const result = await run()
    assert.equal(result.result, 'invalid_args')
    assert.ok(result.errors.some(error => error.field === 'blocks'))
    assert.deepEqual(calls, [])
  }
  const legacy = gatherArgs({ x: 0, y: 64, z: 0, range: 3 })
  assert.ok(legacy.errors.some(error => error.field === 'blocks'))
  assert.deepEqual(gatherArgs({}, true).errors, [])
  assert.ok(gatherArgs({ blocks: [] }, true).errors.some(error => error.field === 'blocks'))
})


test('gather refuses bridges with safety_checks but no auto_tool before world edits', async () => {
  const calls = []
  const result = await gather({ args: { from: point(0), to: point(0), blocks: [wood] },
    api: { call: async (method) => {
      calls.push(method)
      if (method === 'capabilities/list') return [{ name: 'dig', input_schema: { properties: { safety_checks: {} } } }]
      throw new Error('unexpected RPC ' + method)
    } }, sleep: async () => {} })
  assert.equal(result.result, 'unsupported_bridge')
  assert.equal(result.required_capability, 'dig.auto_tool')
  assert.deepEqual(calls, ['capabilities/list'])
})
