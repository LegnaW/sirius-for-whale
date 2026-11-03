#!/usr/bin/env node
/**
 * 诊断：`chat.send` 发的 #goto 为什么没让她动。
 * 三路取证：环境（脚下/周围方块+实体）、chat.send 的原始返回、以及两条通道的 A/B
 * （GUI 聊天栏 vs chat.send）——如果两条都不动，那就是世界/寻路的问题，不是通道的问题。
 * 每步存一张截图到 %TEMP%\sirius-diag-*.png，便于事后看聊天框里的 Baritone 回执。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const GLFW = { T: 84, ENTER: 257, ESC: 256 }

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
const horizontal = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : 0)

const shot = async (tag) => {
  const data = await link.call('screenshot', { tier: 'full' })
  const base64 = data?.image_b64 ?? null
  if (!base64) {
    console.log(`   （截图字段不明：${JSON.stringify(Object.keys(data ?? {}))}）`)
    return null
  }
  const file = join(tmpdir(), `sirius-diag-${tag}.jpg`)
  writeFileSync(file, Buffer.from(base64, 'base64'))
  console.log(`   截图 → ${file}`)
  return file
}

const guiCommand = async (text) => {
  const gui = await link.call('getGuiState', {})
  if (gui?.screen_open === true) {
    await link.call('input.key', { code: GLFW.ESC })
    await sleep(350)
  }
  await link.call('input.key', { code: GLFW.T })
  await sleep(420)
  await link.call('input.text', { string: text })
  await sleep(220)
  await link.call('input.key', { code: GLFW.ENTER })
  await sleep(700)
}

const watchMove = async (from, ms = 6000) => {
  const t0 = Date.now()
  let best = 0
  let last = from
  while (Date.now() - t0 < ms) {
    await sleep(300)
    const now = await readPos()
    if (!now) continue
    last = now
    best = Math.max(best, horizontal(from, now))
    if (best >= 2.5) break
  }
  return { best, last, ms: Date.now() - t0 }
}

const status = await link.status()
console.log(`status: ready=${status.ready} screen=${status.screen}`)
if (!status.ready) { console.log('✖ 未就绪'); process.exit(1) }

const pos = await readPos()
console.log(`pos: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`)

// ---- 1) 她在哪：脚下与周围的方块、附近实体
const blocks = await link.call('world.query', { type: 'blocks', range: 3.4 })
const rows = blocks?.blocks ?? []
const at = new Map()
for (const row of rows) {
  const x = row.x ?? row.pos?.x
  const y = row.y ?? row.pos?.y
  const z = row.z ?? row.pos?.z
  at.set(`${x},${y},${z}`, String(row.block ?? row.name ?? '?').replace('minecraft:', ''))
}
const bx = Math.floor(pos.x)
const by = Math.floor(pos.y)
const bz = Math.floor(pos.z)
console.log(`脚下方块切片（x ${bx - 2}..${bx + 2} / z ${bz - 2}..${bz + 2}，空=air 或未返回）：`)
for (let dy = 1; dy >= -1; dy--) {
  console.log(`  y=${by + dy}:`)
  for (let dz = -2; dz <= 2; dz++) {
    const line = []
    for (let dx = -2; dx <= 2; dx++) {
      line.push((at.get(`${bx + dx},${by + dy},${bz + dz}`) ?? '·').slice(0, 10).padEnd(10))
    }
    console.log(`    ${line.join('')}`)
  }
}
const entities = await link.call('world.query', { type: 'entities', range: 8 })
console.log(`附近实体：${JSON.stringify((entities?.entities ?? []).slice(0, 6).map((e) => `${e.name}(${e.type})`))}`)
await shot('env')

// ---- 2) chat.send 的原始返回
const raw = await link.call('chat.send', { string: '#goto 40 90 -790' })
console.log(`chat.send 原始返回: ${JSON.stringify(raw)}`)
await sleep(1500)
await shot('after-chatsend')
const afterChat = await watchMove(pos, 4000)
console.log(`   chat.send 后位移 ${afterChat.best.toFixed(2)} 格`)
await link.call('chat.send', { string: '#stop' })
await sleep(500)

// ---- 3) 同一条命令走 GUI 聊天栏（已知可用路径）
const pos2 = await readPos()
console.log(`GUI 通道 A/B：T → "#goto 40 90 -790" → ENTER`)
await guiCommand('#goto 40 90 -790')
await sleep(600)
await shot('after-guicmd')
const afterGui = await watchMove(pos2, 6000)
console.log(`   GUI 通道位移 ${afterGui.best.toFixed(2)} 格`)
await guiCommand('#stop')
await sleep(500)
await shot('end')

const verdict = afterGui.best >= 1.2
  ? 'GUI 通道能动 → 世界没问题，问题在 chat.send 通道'
  : 'GUI 通道也不动 → 世界/寻路问题（她现在站的地方走不出去），通道结论待定'
console.log(`\n${verdict}`)
link.close()
process.exit(0)
