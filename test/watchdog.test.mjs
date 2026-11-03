import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Watchdog, WATCH_DEFAULTS, applyDistance, scoreChat } from '../src/watchdog.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeWatchdog (config = {}, now = () => Date.now()) {
  const delivered = []
  const watchdog = new Watchdog({
    deliver: (text) => delivered.push(text),
    log: () => {},
    now,
    config: { observeWindowMs: 10, ...config },
  })
  return { watchdog, delivered }
}

test('chat 命中叫法 → 合并窗口后投递一条', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> sirius 你在吗', system: false } })
  await sleep(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /有人喊我/)
  assert.match(delivered[0], /sirius 你在吗/)
  // 提示里直接给出下一步，模型不用猜
  assert.match(delivered[0], /sirius_status/)
})

test('中文叫法也命中（天狼星/鲸鱼）', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> 鲸鱼过来一下' } })
  await sleep(40)
  assert.equal(delivered.length, 1)
})

test('系统消息与无关聊天不唤醒', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> 早上好', system: false } })
  watchdog.onEvent({ event: 'chat', data: { message: 'Steve joined the game', system: true } })
  watchdog.onEvent({ event: 'gui_open', data: { screen: 'InventoryScreen' } })
  await sleep(40)
  assert.equal(delivered.length, 0)
})

test('危险事件直接唤醒（death / health_low / fire / drown）', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.onEvent({ event: 'death', data: { health: 0, air: 0, on_fire: false } })
  await sleep(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /我死了/)

  watchdog.onEvent({ event: 'health_low', data: { health: 2.5 } })
  await sleep(40)
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /血量过低（2\.5）/)

  watchdog.onEvent({ event: 'fire', data: { health: 12 } })
  watchdog.onEvent({ event: 'drown', data: { air: 120 } })
  await sleep(40)
  assert.equal(delivered.length, 3) // 两个危险事件合并在同一条
  assert.match(delivered[2], /着火了/)
  assert.match(delivered[2], /快淹死/)
})

test('任何实际扣血都强唤醒并标注来源，30 秒冷却从上次伤害起算', async () => {
  let now = 1_000_000
  const { watchdog, delivered } = makeWatchdog({ damageCooldownMs: 30_000 }, () => now)
  const damage = (healthAfter) => ({
    event: 'damage',
    data: {
      health_before: healthAfter + 0.5,
      health_after: healthAfter,
      amount: 0.5,
      damage_type: 'minecraft:player_attack',
      attacker: { name: 'Steve', type: 'minecraft:player', uuid: 'steve-uuid' },
      direct_entity: { name: 'Steve', type: 'minecraft:player', uuid: 'steve-uuid' },
    },
  })
  watchdog.onEvent(damage(19.5))
  await sleep(40)
  assert.equal(delivered.length, 1, '满血时扣半颗心也必须唤醒')
  assert.match(delivered[0], /20 → 19\.5，损失 0\.5/)
  assert.match(delivered[0], /攻击者 Steve（minecraft:player）/)

  now += 29_999
  watchdog.onEvent(damage(19))
  await sleep(40)
  assert.equal(delivered.length, 1, '冷却内不重复叫醒')
  assert.equal(watchdog.stats.damageSuppressed, 1)

  now += 1
  watchdog.onEvent(damage(18.5))
  await sleep(40)
  assert.equal(delivered.length, 2, '冷却边界后再次受伤要唤醒')
})

test('伤害来源区分攻击者与直接实体，未知来源不猜测；开关可关闭', async () => {
  const { watchdog, delivered } = makeWatchdog({ damageCooldownMs: 0 })
  watchdog.onEvent({
    event: 'damage',
    data: {
      health_before: 20,
      health_after: 18,
      amount: 2,
      damage_type: 'minecraft:arrow',
      attacker: { name: 'Skeleton', type: 'minecraft:skeleton' },
      direct_entity: { name: 'Arrow', type: 'minecraft:arrow' },
    },
  })
  await sleep(40)
  assert.match(delivered[0], /攻击者 Skeleton（minecraft:skeleton）/)
  assert.match(delivered[0], /直接伤害实体 Arrow（minecraft:arrow）/)

  watchdog.onEvent({ event: 'damage', data: { health_before: 18, health_after: 17, amount: 1 } })
  await sleep(40)
  assert.match(delivered[1], /来源：未知/)

  const disabled = makeWatchdog({ wakeOn: { damage: false } })
  disabled.watchdog.onEvent({ event: 'damage', data: { health_before: 20, health_after: 19 } })
  await sleep(40)
  assert.equal(disabled.delivered.length, 0)
})

test('窗口内连珠炮合并成一条（不会刷屏）', async () => {
  const { watchdog, delivered } = makeWatchdog({ observeWindowMs: 60 })
  for (const message of ['sirius?', 'sirius 来', 'ai 在吗']) {
    watchdog.onEvent({ event: 'chat', data: { message: `<Steve> ${message}` } })
  }
  await sleep(120)
  assert.equal(delivered.length, 1)
  assert.equal((delivered[0].match(/有人喊我/g) ?? []).length, 3)
})

test('限流：60s 内超过 maxWakePerMinute 就丢弃', async () => {
  const { watchdog, delivered } = makeWatchdog({ observeWindowMs: 10, maxWakePerMinute: 2 })
  for (let i = 0; i < 4; i += 1) {
    watchdog.onEvent({ event: 'death', data: {} })
    await sleep(40)
  }
  assert.equal(delivered.length, 2)
  assert.equal(watchdog.stats.dropped, 2)
})

test('wakeOn 开关可关掉某一类', async () => {
  const { watchdog, delivered } = makeWatchdog({
    wakeOn: { ...WATCH_DEFAULTS.wakeOn, mention: false },
  })
  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> sirius 你在吗' } })
  await sleep(40)
  assert.equal(delivered.length, 0)
})

test('disarm 之后不再唤醒；arm 之后恢复', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.disarm()
  watchdog.onEvent({ event: 'death', data: {} })
  await sleep(40)
  assert.equal(delivered.length, 0)
  watchdog.arm()
  watchdog.onEvent({ event: 'death', data: {} })
  await sleep(40)
  assert.equal(delivered.length, 1)
})

test('非法正则不会炸，只是不命中', async () => {
  const { watchdog, delivered } = makeWatchdog({ mentionPatterns: ['[', 'sirius'] })
  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> sirius hi' } })
  await sleep(40)
  assert.equal(delivered.length, 1)
})

test('自己的发言不唤醒（防自激循环），别人说同样的话才唤醒', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.setSelf('self-uuid')
  watchdog.onEvent({ event: 'chat', data: { message: '<Sirius> sirius 我在这', sender: 'self-uuid' } })
  await sleep(40)
  assert.equal(delivered.length, 0)
  assert.equal(watchdog.stats.selfIgnored, 1)

  watchdog.onEvent({ event: 'chat', data: { message: '<Steve> sirius 我在这', sender: 'other-uuid' } })
  await sleep(40)
  assert.equal(delivered.length, 1)
})

test('投递抛错只记 dropped，不冒泡', async () => {
  const watchdog = new Watchdog({
    deliver: () => { throw new Error('boom') },
    log: () => {},
    config: { observeWindowMs: 10 },
  })
  watchdog.onEvent({ event: 'death', data: {} })
  await sleep(40)
  assert.equal(watchdog.stats.dropped, 1)
})

// ---------------------------------------------------------------- 身份会变（2026-10-31）

test('回声抑制：身份未知时，自己刚说出的话也不唤醒', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.noteSelfSpoke('sirius 我到了')
  watchdog.onEvent({ event: 'chat', data: { message: '<Sirius> sirius 我到了' } })
  await sleep(40)
  assert.equal(delivered.length, 0)
  assert.equal(watchdog.stats.echoIgnored, 1)
})

test('名字前缀兜底：uuid 对不上（换环境/重连）时按 <自己名字> 过滤', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.setSelf('uuid-now', 'Sirius')
  watchdog.onEvent({ event: 'chat', data: { message: '<Sirius> sirius 在吗', sender: 'uuid-old' } })
  await sleep(40)
  assert.equal(delivered.length, 0)
  assert.equal(watchdog.stats.selfIgnored, 1)
})

test('needsSelf：身份会过期（进服务器后 uuid 会变）', () => {
  const { watchdog } = makeWatchdog()
  assert.equal(watchdog.needsSelf(), true, '未设置时需要')
  watchdog.setSelf('uuid-1', 'Sirius')
  assert.equal(watchdog.needsSelf(10_000), false, '刚设置且 ttl 内不需要')
  assert.equal(watchdog.needsSelf(0), true, 'ttl=0 视为立即过期')
})

test('别人说话仍然照常唤醒（过滤不能过头）', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.setSelf('uuid-now', 'Sirius')
  watchdog.noteSelfSpoke('sirius 我到了')
  watchdog.onEvent({ event: 'chat', data: { message: '<PlayerA> sirius 过来', sender: 'uuid-other' } })
  await sleep(40)
  assert.equal(delivered.length, 1)
})

// ---------------------------------------------------------------- 打分与两档（2026-10-31）

test('scoreChat：点名/句首称呼/第二人称/祈使/疑问各自加分', () => {
  const patterns = [new RegExp("sirius", "i")]
  assert.equal(scoreChat("<Steve> 今天的天气不错", { patterns }).score, 0)
  const vocative = scoreChat("<Steve> sirius 过来帮我看看", { patterns })
  assert.ok(vocative.score >= 4, `句首叫名字 + 祈使应到强档：${JSON.stringify(vocative)}`)
  assert.ok(vocative.signals.includes("vocative"))
  const mid = scoreChat("<Steve> 我用 sirius 写了个插件", { patterns })
  // 只在句中提到名字：不够强（没有第二人称/祈使/疑问），不会被叫醒
  assert.ok(mid.score < 4, `句中提到名字不该到强档：${JSON.stringify(mid)}`)
})

test('弱唤醒：没点名但像在跟人说话 → 投递，并明确允许不回应', async () => {
  const { watchdog, delivered } = makeWatchdog()
  watchdog.onEvent({ event: "chat", data: { message: "<Steve> 你过来一下" } })
  await sleep(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /没有点名/)
  assert.match(delivered[0], /自己判断/)
})

test('弱唤醒额度更紧：60s 内最多 maxWeakPerMinute 次', async () => {
  const { watchdog, delivered } = makeWatchdog({ maxWeakPerMinute: 1, quietAfterWakeMs: 0 })
  watchdog.onEvent({ event: "chat", data: { message: "<Steve> 你过来一下" } })
  await sleep(40)
  watchdog.onEvent({ event: "chat", data: { message: "<Alex> 你也在吗" } })
  await sleep(40)
  assert.equal(delivered.length, 1, "第二次弱唤醒应被额度挡掉")
  assert.ok(watchdog.stats.dropped >= 1)
})

test("刚投递过就不叠弱唤醒（quietAfterWakeMs）", async () => {
  const { watchdog, delivered } = makeWatchdog({ quietAfterWakeMs: 5000 })
  watchdog.onEvent({ event: "chat", data: { message: "<Steve> sirius 过来" } })
  await sleep(40)
  watchdog.onEvent({ event: "chat", data: { message: "<Alex> 你在吗" } })
  await sleep(40)
  assert.equal(delivered.length, 1, "强唤醒之后的弱唤醒应先攒着不打扰")
})

test("弱唤醒开关可关（wakeOn.weak=false）", async () => {
  const { watchdog, delivered } = makeWatchdog({ wakeOn: { weak: false } })
  watchdog.onEvent({ event: "chat", data: { message: "<Steve> 你过来一下" } })
  await sleep(40)
  assert.equal(delivered.length, 0)
  assert.equal(watchdog.stats.weak, 0)
})

// ---------------------------------------------------------------- 距离线索（2026-10-31）

test('applyDistance：贴着你/近处 +1，很远 -1，看不清不动', () => {
  assert.equal(applyDistance(2, 'touch'), 3)
  assert.equal(applyDistance(2, 'near'), 3)
  assert.equal(applyDistance(2, 'far'), 1)
  assert.equal(applyDistance(2, 'unknown'), 2)
  assert.equal(applyDistance(0, 'far'), 0, "扣分不该扣成负数")
})

test('近处没点名的插话 → 弱唤醒，报文带距离', async () => {
  const { watchdog, delivered } = makeWatchdog({
    distanceOf: () => ({ band: "near", text: "离你 8 格" }),
  })
  watchdog.onEvent({ event: "chat", data: { message: "<PlayerA> 你过来一下", sender: "u1" } })
  await sleep(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /离你 8 格/)
})

test('远处同样的话 → 降级为不打扰（扣 1 分后不够门限）', async () => {
  const { watchdog, delivered } = makeWatchdog({
    distanceOf: () => ({ band: "far", text: "离你 40 格（很远）" }),
  })
  watchdog.onEvent({ event: "chat", data: { message: "<PlayerA> 你过来一下", sender: "u1" } })
  await sleep(40)
  assert.equal(delivered.length, 0, "远处的人说同样的话不该叫醒")
  assert.ok(watchdog.stats.ignored >= 1)
})

test('点名照旧强唤醒，距离只做附加信息', async () => {
  const { watchdog, delivered } = makeWatchdog({
    distanceOf: () => ({ band: "far", text: "离你 40 格（很远）" }),
  })
  watchdog.onEvent({ event: "chat", data: { message: "<PlayerA> sirius 过来", sender: "u1" } })
  await sleep(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /有人喊我/)
  assert.match(delivered[0], /很远/)
})

test('distanceOf 抛错也不影响唤醒主链', async () => {
  const { watchdog, delivered } = makeWatchdog({
    distanceOf: () => { throw new Error("boom") },
  })
  watchdog.onEvent({ event: "chat", data: { message: "<PlayerA> sirius 你在吗", sender: "u1" } })
  await sleep(40)
  assert.equal(delivered.length, 1)
})
