#!/usr/bin/env node
/**
 * 看门狗真机探针：验证三件事
 *   1. bridge 的 chat 事件真的推送到本地（自己说话也算一条）；
 *   2. 看门狗**忽略自己**的发言（否则 AI 自说自话会把自己叫醒，烧 token 死循环）；
 *   3. 别人喊我（sender 不是自己）会命中 mention 并投递唤醒文本。
 *
 * 第 3 步用一条本地伪造事件（sender 换掉）来验判定分支——真机上要等另一个人开口，
 * 单人存档做不到。
 *
 * 用法：$env:SIRIUS_GAME_DIR='<gameDir>'; node scripts/probe-watchdog.mjs
 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink, EVENT_KINDS } from '../src/bridge.mjs'
import { Watchdog } from '../src/watchdog.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const config = normalizeConfig({
  tokenPath: process.env.SIRIUS_BRIDGE_CONFIG ?? undefined,
  gameDir: process.env.SIRIUS_GAME_DIR ?? undefined,
})
const candidates = findBridgeTokenCandidates(config)
if (candidates.length === 0) { console.error('✖ 没有 token'); process.exit(2) }
const port = candidates.find((candidate) => candidate.port)?.port
const url = port ? `ws://127.0.0.1:${port}` : config.url
const link = new BridgeLink({ url, tokenCandidates: candidates, log: (m) => console.log(`  · ${m}`) })

const delivered = []
const watchdog = new Watchdog({
  deliver: (text) => delivered.push(text),
  log: (m) => console.log(`  · [watchdog] ${m}`),
  config: { observeWindowMs: 600 },
})
link.onEvent((record) => watchdog.onEvent(record))

let exitCode = 1
try {
  const status = await link.status()
  console.log(`status: online=${status.online} ready=${status.ready}`)
  if (!status.online || !status.ready) throw new Error('未就绪')

  await link.subscribe(EVENT_KINDS)
  const players = await link.call('players', {})
  const me = (players?.players ?? []).find((player) => player.self)
  if (me?.uuid) {
    watchdog.setSelf(me.uuid)
    console.log(`self: ${me.name} (${me.uuid})`)
  } else {
    console.log('⚠️ 没拿到自己的 uuid，self 过滤无法验证')
  }
  const sigBefore = link.events({ types: ['chat'], limit: 1 }).at(-1)?.seq ?? -1

  // ---- 1+2：自己说一句带叫法的话
  console.log('chat.send "sirius 在看吗"（自己发言，应被忽略）…')
  await link.call('chat.send', { string: 'sirius 在看吗' })
  await sleep(1600)
  const newChats = link.events({ types: ['chat'], since: sigBefore, limit: 10 })
  console.log(`收到 ${newChats.length} 条 chat 事件：`)
  for (const row of newChats) console.log(`   | ${JSON.stringify(row.data)}`)
  const eventArrived = newChats.length > 0
  const selfIgnored = delivered.length === 0

  // ---- 3：伪造一条"别人喊我"（sender 不是自己）
  console.log('喂一条模拟的他人发言（sender=other-uuid）…')
  watchdog.onEvent({
    event: 'chat',
    data: { message: '<Steve> sirius 过来一下', system: false, sender: 'other-uuid' },
    seq: 9999,
  })
  await sleep(1200)

  console.log(`delivered=${delivered.length}`)
  for (const text of delivered) console.log(`   >>> ${text.replace(/\n/g, ' / ')}`)

  const mentionWoke = delivered.length === 1
  console.log('\n— 判定 —')
  console.log(`chat 事件到达       : ${eventArrived ? '✔' : '✖'}`)
  console.log(`自己发言被忽略       : ${selfIgnored ? '✔' : '✖'}`)
  console.log(`他人叫法触发唤醒     : ${mentionWoke ? '✔' : '✖'}`)
  console.log(`stats: ${JSON.stringify(watchdog.stats)}`)
  exitCode = eventArrived && selfIgnored && mentionWoke ? 0 : 1
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
} finally {
  watchdog.dispose()
  link.close()
}
process.exit(exitCode)
