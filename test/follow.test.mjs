import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FollowTracker } from '../src/follow.mjs'

const target = { uuid: 'p1', name: 'Steve', type: 'minecraft:player' }
const activeFollow = (distance = 20) => ({
  state: 'following',
  follow: { active: true, radius: 10, targets: [{ ...target, distance }] },
})

function fixture ({ now = () => 0, baritone = async () => activeFollow(), status = async () => ({ position: { x: 0, y: 64, z: 0 } }) } = {}) {
  const notices = []
  const stops = []
  const tracker = new FollowTracker({
    status,
    baritone,
    stop: async () => { stops.push('stop') },
    notify: (text) => notices.push(text),
    now,
  })
  return { tracker, notices, stops }
}

test('目标离开实体追踪范围后停止并提醒一次', async () => {
  const { tracker, notices, stops } = fixture({ baritone: async () => ({ follow: { active: false, targets: [] } }) })
  tracker.start({ target, followRadius: 10, owner: 'main' })
  const event = await tracker.tick()
  assert.equal(event.event, 'lost')
  assert.equal(tracker.active, false)
  assert.equal(stops.length, 1)
  assert.match(notices[0], /跟随丢失/)
  assert.equal(await tracker.tick(), null)
  assert.equal(notices.length, 1)
})

test('状态查询暂时失败不会误报目标丢失', async () => {
  const { tracker, notices, stops } = fixture({ baritone: async () => null })
  tracker.start({ target })
  assert.equal(await tracker.tick(), null)
  assert.equal(tracker.active, true)
  assert.equal(notices.length, 0)
  assert.equal(stops.length, 0)
})

test('跟随半径外持续无进展会卡住停止', async () => {
  let at = 0
  const { tracker, notices, stops } = fixture({ now: () => at })
  tracker.start({ target, followRadius: 10 })
  at = 5_000
  const event = await tracker.tick()
  assert.equal(event.event, 'blocked')
  assert.equal(stops.length, 1)
  assert.match(notices[0], /跟随卡住/)
  assert.match(notices[0], /20\.0/)
})

test('进入跟随半径不会误报', async () => {
  const { tracker, notices, stops } = fixture({ baritone: async () => activeFollow(8) })
  tracker.start({ target, followRadius: 10 })
  assert.equal(await tracker.tick(), null)
  assert.equal(await tracker.tick(), null)
  assert.equal(tracker.active, true)
  assert.equal(notices.length, 0)
  assert.equal(stops.length, 0)
})

test('自身持续移动会刷新进展，不误报卡住', async () => {
  let at = 0
  let position = { x: 0, y: 64, z: 0 }
  const { tracker, notices, stops } = fixture({
    now: () => at,
    status: async () => ({ position }),
  })
  tracker.start({ target, followRadius: 10 })
  assert.equal(await tracker.tick(), null)
  at = 5_000
  position = { x: 1, y: 64, z: 0 }
  assert.equal(await tracker.tick(), null)
  assert.equal(tracker.active, true)
  assert.equal(notices.length, 0)
  assert.equal(stops.length, 0)
})

test('显式取消不发送丢失提醒', async () => {
  const { tracker, notices, stops } = fixture()
  tracker.start({ target })
  assert.equal(await tracker.cancel('sirius_stop'), true)
  assert.equal(stops.length, 1)
  assert.equal(notices.length, 0)
  assert.equal(await tracker.cancel('again'), false)
})
