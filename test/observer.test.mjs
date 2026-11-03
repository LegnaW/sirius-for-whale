import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OBSERVE_DEFAULTS, Observer, diffSnapshots } from '../src/observer.mjs'

function makeObserver ({ snapshots = [], config = {} } = {}) {
  let t = 1_000_000
  let index = 0
  const reports = []
  const observer = new Observer({
    config: { ...config },
    now: () => t,
    log: () => {},
    sense: async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? null,
    report: (text) => reports.push(text),
  })
  return { observer, reports, advance: (ms) => { t += ms }, at: () => t, sensed: () => index }
}

const SNAP = (over = {}) => ({
  health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, players: [], hostiles: 0, ...over,
})

test('节律：刚有人说话 → 看勤；平时 → 常量；很久没事 → 越来越懒', () => {
  const { observer, advance } = makeObserver()
  assert.equal(observer.intervalMs(), OBSERVE_DEFAULTS.baseIntervalMs)
  observer.noteChat({ tier: 'weak' })
  assert.equal(observer.intervalMs(), OBSERVE_DEFAULTS.activeIntervalMs)
  advance(OBSERVE_DEFAULTS.activeWindowMs + 1)
  assert.equal(observer.intervalMs(), OBSERVE_DEFAULTS.baseIntervalMs)
  advance(OBSERVE_DEFAULTS.idleAfterMs)
  assert.equal(observer.intervalMs(), OBSERVE_DEFAULTS.idleIntervalMs)
})

test('连续无事会退避（间隔变长，但有上限）', async () => {
  const { observer, advance } = makeObserver({ snapshots: [SNAP(), SNAP(), SNAP(), SNAP()] })
  advance(OBSERVE_DEFAULTS.idleAfterMs + 1)
  const seen = []
  for (let i = 0; i < 4; i += 1) {
    advance(observer.stats.next_in_ms + 1)
    await observer.tick()
    seen.push(observer.intervalMs())
  }
  assert.ok(seen[3] > seen[0], `间隔应随无事件拉长：${seen.join(' → ')}`)
  assert.ok(seen[3] <= OBSERVE_DEFAULTS.idleIntervalMs * OBSERVE_DEFAULTS.maxBackoffMultiply)
})

test('什么都没变 → 看了但不汇报（沉默是常态）', async () => {
  const { observer, reports, advance } = makeObserver({ snapshots: [SNAP(), SNAP()] })
  advance(OBSERVE_DEFAULTS.baseIntervalMs + 1)
  const first = await observer.tick()
  assert.ok(first, '应该真的看了一眼')
  assert.equal(first.reported, false, '第一次没有"变化"，不该汇报')
  advance(observer.stats.next_in_ms + 1)
  const second = await observer.tick()
  assert.equal(second.reported, false)
  assert.equal(reports.length, 0)
})

test('有人走进 16 格 → 汇报一次', async () => {
  const near = SNAP({ players: [{ name: 'PlayerA', distance: 6 }] })
  const { observer, reports, advance } = makeObserver({ snapshots: [SNAP(), near] })
  advance(OBSERVE_DEFAULTS.baseIntervalMs + 1)
  await observer.tick()                      // 建立基线（第一次没有 previous）
  advance(observer.stats.next_in_ms + 1)
  const result = await observer.tick()
  assert.equal(result.reported, true)
  assert.match(reports[0], /PlayerA 出现了/)
  assert.match(reports[0], /朝你走过来/)
})

test('很饿 / 附近多了敌对生物 → 会说；掉血交给即时 damage 事件', async () => {
  const { observer, reports, advance } = makeObserver({
    snapshots: [
      SNAP(),
      SNAP({ health: 15, food: 5, hostiles: 2 }),
    ],
  })
  advance(OBSERVE_DEFAULTS.baseIntervalMs + 1)
  await observer.tick()
  advance(observer.stats.next_in_ms + 1)
  const result = await observer.tick()
  assert.equal(result.reported, true)
  assert.doesNotMatch(reports[0], /掉了 5 点血/)
  assert.match(reports[0], /很饿/)
  assert.match(reports[0], /敌对生物/)
})

test('汇报有静默期：刚说完不会连珠炮', async () => {
  const a = SNAP()
  const b = SNAP({ players: [{ name: 'A', distance: 5 }] })
  const c = SNAP({ players: [{ name: 'A', distance: 5 }, { name: 'B', distance: 7 }] })
  const { observer, reports, advance } = makeObserver({ snapshots: [a, b, c], config: { quietAfterReportMs: 120_000 } })
  advance(OBSERVE_DEFAULTS.baseIntervalMs + 1)
  await observer.tick()
  advance(observer.stats.next_in_ms + 1)
  await observer.tick()
  const afterFirst = reports.length
  advance(observer.stats.next_in_ms + 1)
  await observer.tick()
  assert.equal(reports.length, afterFirst, '静默期内第二次变化先攒着')
})

test('超过小时额度就不汇报了', async () => {
  const snaps = [SNAP()]
  for (let i = 1; i <= 4; i += 1) {
    snaps.push(SNAP({ players: [{ name: `P${i}`, distance: 5 }] }))
  }
  const { observer, reports, advance } = makeObserver({
    snapshots: snaps,
    config: { maxReportsPerHour: 2, quietAfterReportMs: 0 },
  })
  for (let i = 0; i < 4; i += 1) {
    advance(observer.stats.next_in_ms + 1)
    await observer.tick()
  }
  assert.equal(reports.length, 2, '额度用完后保持安静')
})

test('感知失败不炸，节律照常', async () => {
  const observer = new Observer({
    now: () => 1_000_000,
    log: () => {},
    sense: async () => { throw new Error('boom') },
    report: () => { throw new Error('should not report') },
    config: { baseIntervalMs: 1_000 },
  })
  const observerWithClock = observer
  const result = await observerWithClock.tick(2_000_000)
  assert.equal(result, null)
})

test('diffSnapshots：玩家离开也会说一句', () => {
  const notes = diffSnapshots(
    { players: [{ name: 'A', distance: 5 }], health: 20, food: 20 },
    { players: [], health: 20, food: 20 },
  )
  assert.ok(notes.some((note) => note.includes('A 走开了')))
})

test('diffSnapshots：第一次（没有 previous）只报"存在"类事实', () => {
  const notes = diffSnapshots(null, { players: [{ name: 'A', distance: 5 }], health: 20, food: 20 })
  assert.ok(notes.some((note) => note.includes('A 出现了')), '第一次看到有人靠近也应该说')
  assert.ok(!notes.some((note) => note.includes('掉了')), '没有历史就不要编掉血')
})
