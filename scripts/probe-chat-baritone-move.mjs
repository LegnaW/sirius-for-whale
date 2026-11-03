#!/usr/bin/env node
/**
 * 对照组：`chat.send` 已经证明能驱动 Baritone（聊天框里有 "Going to:"），但位移是 0。
 * 这个探针分离两种可能：
 *   ① 她的身体根本没在跑物理（窗口失焦/游戏暂停/被 freeze）→ 注入 W 也不会动；
 *   ② 身体正常，是 Baritone 找不到路 → 注入 W 会动，`#goto` 不动。
 *
 * `input.key` 走的是 `KeyboardHandler.keyPress` 真实回调（不吃窗口焦点），所以 W 是合法对照。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const W = 87

const config = normalizeConfig({
  url: process.env.SIRIUS_BRIDGE_URL ?? undefined,
  gameDir: process.env.SIRIUS_GAME_DIR ?? undefined,
})
const candidates = findBridgeTokenCandidates(config)
const port = candidates.find((candidate) => candidate.port)?.port
const link = new BridgeLink({ url: port ? `ws://127.0.0.1:${port}` : config.url, tokenCandidates: candidates, log: (m) => console.log(`  · ${m}`) })

const readPos = async () => {
  const stats = await link.call('getStats', {})
  return stats?.in_game === true ? stats.position : null
}
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const show = (p) => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`

const shot = async (tag) => {
  const data = await link.call('screenshot', { tier: 'full' })
  if (!data?.image_b64) return
  const file = join(tmpdir(), `sirius-move-${tag}.jpg`)
  writeFileSync(file, Buffer.from(data.image_b64, 'base64'))
  console.log(`   截图 → ${file}`)
}

const status = await link.status()
if (!status.ready) { console.log('✖ 未就绪'); process.exit(1) }

// ---- 对照：按住 W 0.9s
const a = await readPos()
console.log(`对照前: ${show(a)}`)
await link.call('input.key', { code: W, duration_ms: 900 })
await sleep(400)
const b = await readPos()
const walked = dxz(a, b)
console.log(`按住 W 0.9s 后: ${show(b)}  水平位移 ${walked.toFixed(2)} 格`)

// ---- 实验：chat.send 发一个远一点的目标
const tx = Math.round(b.x) + 20
const tz = Math.round(b.z) + 20
const ty = Math.round(b.y)
console.log(`chat.send("#goto ${tx} ${ty} ${tz}") → 观察 15s`)
await link.call('chat.send', { string: `#goto ${tx} ${ty} ${tz}` })
const t0 = Date.now()
let best = 0
let last = b
while (Date.now() - t0 < 15_000) {
  await sleep(400)
  const now = await readPos()
  if (!now) continue
  last = now
  best = Math.max(best, dxz(b, now))
  if (best >= 8) break
}
await shot('goto')
await link.call('chat.send', { string: '#stop' })
await sleep(600)
await shot('stop')
const c = await readPos()
console.log(`15s 内 baritone 最大水平位移 ${best.toFixed(2)} 格，终点 ${show(last ?? c)}`)

console.log('')
if (walked < 0.2) {
  console.log('✖ 连注入 W 都不动 → 她的身体没有在跑物理（窗口失焦/暂停/被别的进程按住了？），Baritone 结论待定')
} else if (best >= 2) {
  console.log('✔ 身体正常 + Baritone 能动：chat.send 通道完全打通（0 界面开销）')
} else {
  console.log('△ 身体正常（W 能动）但 #goto 不动 → 是寻路问题（目标/地形/allowBreak），通道没问题')
}
link.close()
process.exit(0)
