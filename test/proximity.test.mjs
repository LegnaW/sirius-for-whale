import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROXIMITY_DEFAULTS,
  Proximity,
  SELF_EPSILON,
  distanceBand,
  formatDistance,
  horizontalDistance,
  isSelfEntity,
} from '../src/proximity.mjs'

const ENTITIES = [
  { uuid: 'u-self', name: 'Sirius', type: 'minecraft:player', position: { x: 0, y: 64, z: 0 } },
  { uuid: 'u-near', name: 'PlayerA', type: 'minecraft:player', position: { x: 8, y: 64, z: 0 } },
  { uuid: 'u-mid', name: 'PlayerB', type: 'minecraft:player', position: { x: 20, y: 64, z: 0 } },
  { uuid: 'u-far', name: 'PlayerC', type: 'minecraft:player', position: { x: 40, y: 70, z: 0 } },
  { uuid: 'u-bat', name: '蝙蝠', type: 'minecraft:bat', position: { x: 2, y: 64, z: 0 } },
]

function makeProximity ({ entities = ENTITIES, me = { x: 0, y: 64, z: 0 }, now, self } = {}) {
  let t = 0
  let calls = 0
  const proximity = new Proximity({
    query: async () => { calls += 1; return entities },
    stats: async () => ({ position: me }),
    ...(self ? { self } : {}),
    log: () => {},
    now: now ?? (() => t),
  })
  return {
    proximity,
    advance: (ms) => { t += ms },
    calls: () => calls,
  }
}

test('distanceBand：分段边界', () => {
  assert.equal(distanceBand(0.5), 'touch')
  assert.equal(distanceBand(3), 'touch')
  assert.equal(distanceBand(12), 'near')
  assert.equal(distanceBand(20), 'mid')
  assert.equal(distanceBand(48), 'far')
  assert.equal(distanceBand(Number.NaN), 'unknown')
})

test('formatDistance：看得见给数字，看不见就明说看不见', () => {
  assert.match(formatDistance(1.2), /贴着你/)
  assert.match(formatDistance(8.4), /离你 8 格/)
  assert.match(formatDistance(20), /有点远/)
  assert.match(formatDistance(45), /很远/)
  assert.match(formatDistance(Number.NaN), /看不清/)
})

test('horizontalDistance：只算水平距离，缺坐标给 NaN', () => {
  assert.equal(horizontalDistance({ x: 0, y: 64, z: 0 }, { x: 3, y: 100, z: 4 }), 5)
  assert.ok(Number.isNaN(horizontalDistance(null, { x: 0, z: 0 })))
})

test('快照：只算玩家，按距离升序，怪物只计数', async () => {
  const { proximity } = makeProximity()
  const snap = await proximity.refresh()
  assert.deepEqual(snap.players.map((p) => p.name), ['PlayerA', 'PlayerB', 'PlayerC'])
  assert.equal(snap.players[0].distance, 8)
  assert.equal(snap.players[0].band, 'near')
  assert.equal(snap.players[2].band, 'far')
  assert.equal(snap.mobs, 1)
})

test('lookup：按 uuid 或名字都能查；查不到就是 unknown', async () => {
  const { proximity } = makeProximity()
  await proximity.refresh()
  assert.equal(proximity.lookup('u-near').band, 'near')
  assert.equal(proximity.lookup('PlayerB').band, 'mid')
  const missing = proximity.lookup('nobody')
  assert.equal(missing.band, 'unknown')
  assert.match(missing.text, /看不清/)
})

test('TTL 内复用快照，过期才重新查询', async () => {
  const { proximity, advance, calls } = makeProximity()
  await proximity.refresh()
  await proximity.refresh()
  assert.equal(calls(), 1, 'TTL 内不该再查')
  advance(PROXIMITY_DEFAULTS.ttlMs + 1)
  await proximity.refresh()
  assert.equal(calls(), 2)
})

test('并发刷新只发一次查询', async () => {
  const { proximity, calls } = makeProximity()
  await Promise.all([proximity.refresh(), proximity.refresh(), proximity.refresh()])
  assert.equal(calls(), 1)
})

test('查询失败不炸：保留上一份快照并计数', async () => {
  let fail = false
  const proximity = new Proximity({
    query: async () => { if (fail) throw new Error('boom'); return ENTITIES },
    stats: async () => ({ position: { x: 0, y: 64, z: 0 } }),
    log: () => {},
  })
  await proximity.refresh()
  fail = true
  const again = await proximity.refresh(true)
  assert.ok(again, '失败后应回退到上一份快照')
  assert.equal(proximity.stats.failures, 1)
})

test('describeNearby：只列看得见的，给"谁在我旁边"用', async () => {
  const { proximity } = makeProximity()
  await proximity.refresh()
  const text = proximity.describeNearby(2)
  assert.match(text, /PlayerA/)
  assert.ok(!text.includes('Sirius'), '"附近的人"不该是她自己')
  assert.ok(!text.includes('PlayerC'), 'limit=2 只列最近两个')
})

// ---------------------------------------------------------------- 她自己不算"附近的人"

test('isSelfEntity：uuid 命中就是自己', () => {
  const me = { x: 0, y: 64, z: 0 }
  const entity = { uuid: 'u-self', name: 'Sirius', position: { x: 0, y: 64, z: 0 } }
  assert.equal(isSelfEntity(entity, me, { uuid: 'u-self', name: 'Sirius' }), true)
})

test('isSelfEntity：服务器换了 uuid，靠名字还能认出', () => {
  const me = { x: 0, y: 64, z: 0 }
  const entity = { uuid: 'new-uuid', name: 'Sirius', position: { x: 0, y: 64, z: 0 } }
  assert.equal(isSelfEntity(entity, me, { uuid: 'old-uuid', name: 'Sirius' }), true)
  assert.equal(isSelfEntity(entity, me, { uuid: 'old-uuid', name: null }), false)
})

test('isSelfEntity：身份未知时按"贴脸"兜底，但别人站远一点不会被误杀', () => {
  const me = { x: 0, y: 64, z: 0 }
  assert.equal(isSelfEntity({ uuid: 'x', position: { x: 0, y: 64, z: 0 } }, me, null), true)
  assert.equal(isSelfEntity({ uuid: 'x', position: { x: 1, y: 64, z: 0 } }, me, null), false)
  assert.ok(SELF_EPSILON < 1)
})

test('快照：身份已知时，贴脸站着的别人仍然是"人"', async () => {
  const entities = [
    { uuid: 'u-self', name: 'Sirius', type: 'minecraft:player', position: { x: 0, y: 64, z: 0 } },
    { uuid: 'u-hug', name: 'Baobao', type: 'minecraft:player', position: { x: 0.1, y: 64, z: 0 } },
  ]
  const { proximity } = makeProximity({ entities, self: () => ({ uuid: 'u-self', name: 'Sirius' }) })
  const snap = await proximity.refresh()
  assert.deepEqual(snap.players.map((p) => p.name), ['Baobao'])
})

test('自主提醒里不再出现她自己的名字', async () => {
  const { proximity } = makeProximity({ self: () => ({ uuid: 'u-self', name: 'Sirius' }) })
  await proximity.refresh()
  const text = proximity.describeNearby() ?? ''
  assert.ok(!text.includes('Sirius'), `附近列表：${text}`)
  assert.match(text, /PlayerA/)
})
