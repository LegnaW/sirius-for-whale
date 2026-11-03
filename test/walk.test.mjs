import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WalkTracker } from '../src/walk.mjs'

function makeTracker ({ positions = [{ x: 0, y: 64, z: 0 }], blocks = [], useResult = { result: 'used' }, config = {} } = {}) {
  let t = 1_000_000
  let reads = 0
  const commands = []
  const notes = []
  const calls = []
  const tracker = new WalkTracker({
    now: () => t,
    log: () => {},
    config: { stallMs: 4500, ...config },
    status: async () => ({
      online: true,
      inGame: true,
      ready: true,
      position: positions[Math.min(reads++, positions.length - 1)],
      health: 20,
      food: 20,
    }),
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'world.query') return { blocks }
      if (method === 'use') return useResult
      return { ok: true }
    },
    command: async (text) => { commands.push(text); return {} },
    notify: (text) => notes.push(text),
  })
  return { tracker, commands, notes, calls, advance: (ms) => { t += ms }, reads: () => reads }
}

test('start：返回 walk id 与即将发送的命令，并登记为 ongoing', () => {
  const { tracker } = makeTracker()
  const walk = tracker.start({ x: 10, z: -5, owner: 'agent-1' })
  assert.match(walk.id, /^walk-/)
  assert.equal(walk.owner, 'agent-1')
  assert.equal(walk.command, '#goto 10 -5')
  assert.equal(tracker.active, true)
  assert.equal(tracker.snapshot().target.x, 10)
})

test('y 给了就发三维 #goto', () => {
  const { tracker } = makeTracker()
  assert.equal(tracker.start({ x: 1, y: 70, z: 2 }).command, '#goto 1 70 2')
})

test('tick：同 X/Z 但高度不符不能判到达', async () => {
  const { tracker, advance } = makeTracker({ positions: [{ x: 0, y: 64, z: 0 }] })
  tracker.start({ x: 0, y: 70, z: 0 })
  await tracker.tick()
  advance(5_000)
  const result = await tracker.tick()
  assert.equal(result.event, 'no_progress')
  assert.notEqual(result.event, 'arrived')
})

test('tick：三维目标水平与高度都满足才到达', async () => {
  const { tracker } = makeTracker({ positions: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 70, z: 0 }] })
  tracker.start({ x: 0, y: 70, z: 0 })
  await tracker.tick()
  const result = await tracker.tick()
  assert.equal(result.event, 'arrived')
})

test('tick：在走（还没到）→ 不产生事件、不汇报', async () => {
  const { tracker, notes, commands, advance } = makeTracker({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
  })
  tracker.start({ x: 20, z: 0 })
  const first = await tracker.tick()
  assert.equal(first, null)
  const second = await tracker.tick()
  assert.equal(second, null)
  assert.equal(notes.length, 0)
  assert.ok(!commands.includes('#stop'))
})

test('tick：进入公差 → 发 #stop 并汇报〔到达〕一次，然后注销', async () => {
  const { tracker, notes, commands, advance } = makeTracker({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 9.6, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }],
  })
  tracker.start({ x: 10, z: 0 })
  await tracker.tick()                 // 起点
  const done = await tracker.tick()    // 进公差
  assert.equal(done.event, 'arrived')
  assert.ok(commands.includes('#stop'))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /〔到达〕/)
  assert.equal(tracker.active, false)
  assert.equal(await tracker.tick(), null, '终局之后不再推进')
})

test('tick：卡住且附近有门 → 用 use 打开并重发 #goto，不报卡住', async () => {
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_fence_gate' }
  const { tracker, commands, notes, calls, advance } = makeTracker({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
  })
  tracker.start({ x: 20, z: 0 })
  await tracker.tick()          // 基线
  advance(1000)
  await tracker.tick()          // 动了一下（刷新进度）
  advance(5000)
  const result = await tracker.tick()   // 停住 → 找门
  assert.equal(result, null, '开门成功就不该判卡住')
  assert.ok(calls.some((call) => call.method === 'use'), '应该尝试用 use 开门')
  assert.ok(commands.filter((text) => text.startsWith('#goto')).length >= 1, '开门后应重发 #goto（首条由调用方发出）')
  assert.equal(notes.length, 0)
  assert.equal(tracker.snapshot().opened, 1)
})

test('tick：卡住且门打不开 → 汇报〔卡住〕并带最近门口信息', async () => {
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_door' }
  const { tracker, notes, commands, advance } = makeTracker({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
    useResult: { result: 'no_effect' },
  })
  tracker.start({ x: 20, z: 0 })
  await tracker.tick()          // 基线
  advance(1000)
  await tracker.tick()          // 动了一下
  advance(5000)
  const result = await tracker.tick()   // 停住 → 门打不开 → blocked
  assert.equal(result.event, 'blocked')
  assert.match(notes[0], /〔卡住〕/)
  assert.match(notes[0], /oak_door/)
  assert.ok(commands.includes('#stop'))
})

test('tick：一步没动 → 报〔没动〕（提示 Baritone 可能没装）', async () => {
  const { tracker, notes, advance } = makeTracker({ positions: [{ x: 0, y: 64, z: 0 }] })
  tracker.start({ x: 30, z: 0 })
  await tracker.tick()
  advance(5000)
  const result = await tracker.tick()
  assert.equal(result.event, 'no_progress')
  assert.match(notes[0], /Baritone/)
})

test('tick：超时 → 汇报〔超时〕', async () => {
  const { tracker, notes, advance } = makeTracker({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }],
    config: { stallMs: 60_000 },
  })
  tracker.start({ x: 100, z: 0, timeoutMs: 3_000 })
  await tracker.tick()
  advance(3_500)
  const result = await tracker.tick()
  assert.equal(result.event, 'timeout')
  assert.match(notes[0], /〔超时〕/)
})

test('cancel：发 #stop 并注销', async () => {
  const { tracker, commands } = makeTracker()
  tracker.start({ x: 1, z: 1 })
  assert.equal(await tracker.cancel('用户改主意'), true)
  assert.ok(commands.includes('#stop'))
  assert.equal(tracker.active, false)
  assert.equal(await tracker.cancel('再来一次'), false, '没有活动任务时应返回 false')
})

test('新的 start 直接取代旧的（只保留一段）', () => {
  const { tracker } = makeTracker()
  tracker.start({ x: 1, z: 1 })
  const second = tracker.start({ x: 2, z: 2 })
  assert.equal(tracker.snapshot().id, second.id)
  assert.equal(tracker.snapshot().target.x, 2)
})

test('不在游戏里 → 作废并汇报', async () => {
  const tracker = new WalkTracker({
    now: () => 1,
    log: () => {},
    status: async () => ({ online: true, inGame: false }),
    call: async () => ({}),
    command: async () => ({}),
    notify: () => {},
  })
  tracker.start({ x: 1, z: 1 })
  const result = await tracker.tick()
  assert.equal(result.event, 'left_game')
})
