import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gather } from '../src/plugin/gather.mjs'

const seed = { x: 0, y: 64, z: 0 }
const ore = 'testmod:custom_ore'

function fixture ({ limit = 12, range = 3, unsafe = false, target = ore, strict = true, approach = false, pickup = false, partialSupport = false, underfoot = false } = {}) {
  const blocks = new Map([
    ['0,64,0', target], ['1,65,1', target], ['2,64,0', target], ['1,65,2', 'minecraft:gold_ore'],
    ['0,63,-2', 'minecraft:stone'],
  ])
  const calls = []
  let collected = 0
  let position = approach ? { x: 0.5, y: 64, z: -5.5 } : { x: 0.5, y: 64, z: -1.5 }
  let drop = null
  if (partialSupport) {
    position = { x: 0.5, y: 63.5, z: -1.5 }
    blocks.set('0,64,-2', 'minecraft:short_grass')
  }
  if (underfoot) position = { x: 0.5, y: 65, z: 0.5 }
  if (approach) blocks.set('0,64,-1', 'minecraft:stone')
  if (pickup) blocks.set('0,63,0', 'minecraft:stone')
  const run = () => gather({
    args: { ...seed, range, max_blocks: limit },
    sleep: async () => {},
    api: {
      call: async (method, p) => {
        calls.push({ method, p })
        const key = [p.x, p.y, p.z].join(',')
        switch (method) {
          case 'capabilities/list': return [{ name: 'dig', input_schema: { properties: strict ? { expected_block: {} } : {} } }]
          case 'block.get': {
            const block = blocks.get(key) ?? 'minecraft:air'
            return { status: 'ok', block, air: !blocks.has(key), breakable: true,
              passable: !blocks.has(key) || block === 'minecraft:short_grass',
              support_height: partialSupport && key === '0,63,-2' ? 0.5 : 1,
              safe_support: block === 'minecraft:stone' || underfoot && block === target }
          }
          case 'getStats': return { in_game: true, health: 20, position }
          case 'baritone.status': return { state: 'arrived' }
          case 'inventory': return { in_game: true, counts: { 'minecraft:raw_iron': collected } }
          case 'world.query': return { entities: drop ? [drop] : [] }
          case 'baritone.goto':
            position = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
            if (drop && p.x === 0 && p.z === 0) { collected++; drop = null }
            return { result: 'started' }
          case 'baritone.stop': return { result: 'stopped' }
          case 'dig':
            if (unsafe) return { result: 'blocked_liquid' }
            assert.equal(p.expected_block, blocks.get(key))
            blocks.delete(key)
            if (pickup) drop = { uuid: 'fresh', item: 'minecraft:raw_iron', count: 1, position: { x: 0.5, y: 64, z: 0.5 } }
            else collected++
            return { result: 'broken', drops: [{ item: 'minecraft:raw_iron', count: 1 }] }
          default: throw new Error(method)
        }
      },
    },
  })
  return { run, calls }
}

test('gather finds matching mod blocks and counts actual inventory gain', async () => {
  const { run } = fixture()
  const result = await run()
  assert.equal(result.result, 'area_exhausted')
  assert.equal(result.mined, 2)
  assert.deepEqual(result.collected, { 'minecraft:raw_iron': 2 })
})

test('gather enforces the block cap and reports unsafe mines as incomplete', async () => {
  const capped = fixture({ limit: 1 })
  assert.equal((await capped.run()).result, 'limit_reached')
  assert.equal(capped.calls.filter(call => call.method === 'dig').length, 1)
  const blocked = await fixture({ unsafe: true }).run()
  assert.equal(blocked.result, 'area_incomplete')
  assert.equal(blocked.mined, 0)
  assert.equal(blocked.skipped[0].reason, 'blocked_liquid')
})

test('gather does not call legacy dig without strict target protection', async () => {
  const legacy = fixture({ strict: false })
  assert.equal((await legacy.run()).result, 'unsupported_bridge')
  assert.deepEqual(legacy.calls.map(call => call.method), ['capabilities/list'])
})

test('gather accepts logs and expands the cube only when range is increased', async () => {
  const { run, calls } = fixture({ range: 5, target: 'minecraft:oak_log' })
  const result = await run()
  assert.equal(result.result, 'area_exhausted')
  assert.equal(result.mined, 3)
  assert.ok(calls.filter(call => call.method === 'dig').every(call => call.p.expected_block === 'minecraft:oak_log'))
  const invalid = fixture({ range: 4 })
  assert.equal((await invalid.run()).result, 'invalid_args')
  assert.deepEqual(invalid.calls, [])
})

test('gather approaches from a stand near the target, including a one-block rise', async () => {
  const { run, calls } = fixture({ limit: 1, approach: true })
  const result = await run()
  assert.equal(result.result, 'limit_reached')
  const path = calls.find(call => call.method === 'baritone.goto')
  assert.deepEqual(path.p, { x: 0, y: 65, z: -1, allow_break: false, allow_place: false })
  assert.ok(calls.findIndex(call => call.method === 'baritone.stop') < calls.findIndex(call => call.method === 'dig'))
  assert.equal(result.break_evidence, 'client_block_readback')
})

test('gather chases a fresh drop after breaking and checks the batch inventory delta', async () => {
  const { run, calls } = fixture({ limit: 1, pickup: true })
  const result = await run()
  assert.equal(result.result, 'limit_reached')
  assert.deepEqual(result.collected, { 'minecraft:raw_iron': 1 })
  assert.deepEqual(result.uncollected, {})
  assert.ok(calls.findIndex(call => call.method === 'baritone.goto') > calls.findIndex(call => call.method === 'dig'))
  assert.equal(calls.filter(call => call.method === 'inventory').length, 2)
})

test('gather accepts passable plants above a partial collision surface', async () => {
  const { run, calls } = fixture({ limit: 1, partialSupport: true })
  assert.equal((await run()).result, 'limit_reached')
  assert.ok(calls.some(call => call.method === 'dig'))
  assert.ok(!calls.some(call => call.method === 'baritone.goto'))
})

test('gather delegates removal of the current support to the Bridge landing check', async () => {
  const { run, calls } = fixture({ limit: 1, underfoot: true })
  assert.equal((await run()).result, 'limit_reached')
  assert.deepEqual(calls.find(call => call.method === 'dig').p.expected_block, ore)
})
