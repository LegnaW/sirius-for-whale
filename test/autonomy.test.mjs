import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Autonomy, AUTONOMY_DEFAULTS, buildNotice, pickDrive } from '../src/autonomy.mjs'

function makeAutonomy (config = {}) {
  let t = 1_000_000
  const delivered = []
  const autonomy = new Autonomy({
    deliver: (text) => delivered.push(text),
    log: () => {},
    config: { ...config },
    now: () => t,
  })
  return {
    autonomy,
    delivered,
    advance: (ms) => { t += ms },
    at: () => t,
  }
}

test('pickDrive：血量/饱食/有人在线/无事可做 的优先级', () => {
  assert.equal(pickDrive({ health: 6, food: 20, players: [] }), 'hurt')
  assert.equal(pickDrive({ health: 20, food: 8, players: [] }), 'hunger')
  assert.equal(pickDrive({ health: 20, food: 20, players: [{ name: 'A' }] }), 'company')
  assert.equal(pickDrive({ health: 20, food: 20, players: [] }), 'wander')
  // 自己不算"有人在线"
  assert.equal(pickDrive({ health: 20, food: 20, players: [{ name: 'me', self: true }] }), 'wander')
})

test('pickDrive：桥的 self 标错时，按自己的名字也把她自己排除', () => {
  // 真机（用户2026-10-31）：提醒里"附近有人"，那个"人"其实是她自己
  const players = [{ name: 'Sirius' }, { name: 'PlayerA' }]
  assert.equal(pickDrive({ health: 20, food: 20, players, selfName: 'Sirius' }), 'company')
  assert.equal(pickDrive({ health: 20, food: 20, players: [{ name: 'Sirius' }], selfName: 'Sirius' }), 'wander')
})

test('buildNotice：在线玩家列表里不出现她自己', () => {
  const text = buildNotice({
    health: 20,
    food: 20,
    players: [{ name: 'Sirius' }],
    selfName: 'Sirius',
  }, 'wander')
  assert.match(text, /在线玩家：只有你/)
  assert.ok(!text.includes('Sirius'), text)
})

test('buildNotice：给事实、给建议，并且明确允许什么都不做', () => {
  const text = buildNotice({
    health: 14,
    food: 6,
    position: { x: 12.3, y: 64, z: -8.1 },
    players: [{ name: 'me', self: true }, { name: 'PlayerB' }],
  }, 'hunger')
  assert.match(text, /自主时间/)
  assert.match(text, /血量 14/)
  assert.match(text, /饱食 6/)
  assert.match(text, /12\.3/)
  assert.match(text, /PlayerB/)
  assert.match(text, /也可以什么都不做/)
  assert.match(text, /不要刷屏/)
})

test('空闲不够 → 不开口', () => {
  const { autonomy, advance } = makeAutonomy()
  advance(10_000)
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
})

test('空闲够了 → 开口，并投递一条', () => {
  const { autonomy, delivered, advance, at } = makeAutonomy()
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 1_000)
  const decision = autonomy.shouldFire({ online: true, inGame: true })
  assert.ok(decision)
  autonomy.fire({ online: true, inGame: true, health: 20, food: 20, players: [] }, at())
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /自主时间/)
  assert.equal(autonomy.stats.fires, 1)
})

test('不在游戏 / 没连上 → 永不开口', () => {
  const { autonomy, advance } = makeAutonomy()
  advance(10 * 60_000)
  assert.equal(autonomy.shouldFire({ online: false, inGame: false }), null)
  assert.equal(autonomy.shouldFire({ online: true, inGame: false }), null)
})

test('人类刚说过话 → 安静一段时间', () => {
  const { autonomy, advance } = makeAutonomy()
  advance(10 * 60_000)
  autonomy.noteHumanActivity()
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
  advance(AUTONOMY_DEFAULTS.quietAfterHumanMs + 1_000)
  // 人类活动也把"空闲"重新计时了，所以还得再等 idleAfterMs
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
  advance(AUTONOMY_DEFAULTS.idleAfterMs)
  assert.ok(autonomy.shouldFire({ online: true, inGame: true }))
})

test('agent 在跑的时候不插嘴', () => {
  const { autonomy, advance } = makeAutonomy()
  advance(10 * 60_000)
  autonomy.noteStatus('running')
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
  autonomy.noteStatus('idle')
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null, '刚回到 idle 要重新计时')
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 1_000)
  assert.ok(autonomy.shouldFire({ online: true, inGame: true }))
})

test('两次自主之间至少 minGapMs', () => {
  const { autonomy, advance, at } = makeAutonomy()
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 1)
  autonomy.fire({ online: true, inGame: true }, at())
  advance(30_000)
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
  advance(AUTONOMY_DEFAULTS.minGapMs)
  assert.ok(autonomy.shouldFire({ online: true, inGame: true }))
})

test('上一轮自主太短 → 间隔翻倍（防"烧 token 的自嗨循环"）', () => {
  const { autonomy, advance, at } = makeAutonomy()
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 1)
  autonomy.fire({ online: true, inGame: true }, at())
  // 一轮只跑了 5 秒就结束
  autonomy.noteStatus('running', at())
  advance(5_000)
  autonomy.noteStatus('idle', at())
  assert.equal(autonomy.stats.next_gap_ms, AUTONOMY_DEFAULTS.minGapMs * AUTONOMY_DEFAULTS.backoffFactor)
  assert.equal(autonomy.stats.skipped_short, 1)
})

test('上一轮自主有实质内容 → 间隔恢复', () => {
  const { autonomy, advance, at } = makeAutonomy()
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 1)
  autonomy.fire({ online: true, inGame: true }, at())
  autonomy.noteStatus('running', at())
  advance(60_000)
  autonomy.noteStatus('idle', at())
  assert.equal(autonomy.stats.next_gap_ms, AUTONOMY_DEFAULTS.minGapMs)
})

test('每小时上限 maxPerHour', () => {
  const { autonomy, advance, at } = makeAutonomy({ maxPerHour: 2, minGapMs: 1_000 })
  for (let i = 0; i < 2; i += 1) {
    advance(AUTONOMY_DEFAULTS.idleAfterMs + 2_000)
    assert.ok(autonomy.shouldFire({ online: true, inGame: true }), `第 ${i + 1} 次应放行`)
    autonomy.fire({ online: true, inGame: true }, at())
  }
  advance(AUTONOMY_DEFAULTS.idleAfterMs + 2_000)
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null, '超过每小时上限就该闭嘴')
})

test('enabled=false 时完全不动', () => {
  const { autonomy, advance } = makeAutonomy({ enabled: false })
  advance(60 * 60_000)
  assert.equal(autonomy.shouldFire({ online: true, inGame: true }), null)
})

test('buildNotice：带"附近有谁"这一行（距离线索进自主提示）', () => {
  const text = buildNotice({
    health: 20,
    food: 20,
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'me', self: true }],
    nearbyPlayers: 'PlayerA（离你 8 格）',
  }, 'company')
  assert.match(text, /附近：PlayerA（离你 8 格）/)
})
