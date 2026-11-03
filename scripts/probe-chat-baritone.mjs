#!/usr/bin/env node
/**
 * 探针：Baritone 的命令能不能走 `chat.send`（不开聊天栏）。
 *
 * 依据（2026-10-31 读 Baritone 源码发现）：
 *   · Baritone 的命令入口是 mixin 注入 `ClientPacketListener.sendChat(String)` 的 HEAD
 *     （src/launch/.../MixinClientPlayNetHandler.java），命中 `#` 前缀就 `ci.cancel()`；
 *   · 桥的 `chat.send` 调用的正是 `connection.sendChat(text)`（ChatTools.java:81）。
 * 所以 `chat.send("#goto …")` 理论上会被 Baritone 吃掉并执行，服务器永远看不到。
 *
 * 旧笔记（M4.4-real.md §3.1）说"chat.send 不执行 / 或 # 开头"，那次测的是 `/give`
 * ——服务器命令确实不行（`/` 是聊天栏 GUI 自己特判的），但 `#` 从没测过。
 *
 * 本探针两路取证：
 *   ① 位移：发 `#goto` 后坐标有没有动（真的被执​行的硬证据）；
 *   ② 泄漏：事件流里有没有出现带 `#` 的 chat 回显（被当普通聊天发出去 = 没被拦截）。
 *
 * 用法：
 *   $env:SIRIUS_GAME_DIR='<gameDir>'; node scripts/probe-chat-baritone.mjs
 *   node scripts/probe-chat-baritone.mjs --url ws://127.0.0.1:8765 --token <hex>
 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function argOf (name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const config = normalizeConfig({
  url: argOf('url') ?? process.env.SIRIUS_BRIDGE_URL ?? undefined,
  token: argOf('token') ?? undefined,
  tokenPath: process.env.SIRIUS_BRIDGE_CONFIG ?? undefined,
  gameDir: process.env.SIRIUS_GAME_DIR ?? undefined,
})
const candidates = findBridgeTokenCandidates(config)
if (candidates.length === 0) {
  console.error('✖ 没有 token；给 SIRIUS_GAME_DIR / SIRIUS_BRIDGE_CONFIG 或 --token')
  process.exit(2)
}
const port = candidates.find((candidate) => candidate.port)?.port
const url = port ? `ws://127.0.0.1:${port}` : config.url
const link = new BridgeLink({ url, tokenCandidates: candidates, log: (m) => console.log(`  · ${m}`) })

const readPos = async () => {
  const stats = await link.call('getStats', {})
  return stats?.in_game === true ? stats.position : null
}
const horizontal = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : 0)

/** 当前事件流里最大的 seq（用作"从现在开始"的游标）。 */
const headSeq = () => {
  const rows = link.events({ limit: 1 })
  return rows.length > 0 && typeof rows[0].seq === 'number' ? rows[0].seq : 0
}

/** 从 since 之后，有没有泄漏到服务器的 `#` 聊天。 */
const leaksSince = (since) => link.events({ types: ['chat'], since, limit: 80 })
  .map((row) => String(row.data?.message ?? ''))
  .filter((text) => text.includes('#'))

const send = (text) => link.call('chat.send', { string: text })

const DIRECTIONS = [
  { name: '+x', dx: 4, dz: 0 },
  { name: '-x', dx: -4, dz: 0 },
  { name: '+z', dx: 0, dz: 4 },
  { name: '-z', dx: 0, dz: -4 },
]

let exitCode = 0
try {
  const status = await link.status()
  console.log(`status: online=${status.online} inGame=${status.inGame} ready=${status.ready} screen=${status.screen}`)
  if (!status.online || !status.ready) {
    console.error('✖ 未就绪（不在世界或界面开着）')
    process.exit(1)
  }
  await link.subscribe(['chat'])

  const start = await readPos()
  if (!start) throw new Error('读不到坐标')
  console.log(`pos0: ${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}`)

  // ---- 0) 先发一条 #stop 当"探子"：如果它出现在聊天回显里，说明根本没被拦截
  const seqBefore = headSeq()
  await send('#stop')
  await sleep(1200)
  const leakStop = leaksSince(seqBefore)
  console.log(leakStop.length === 0
    ? '#stop 探子：没有泄漏到服务器（好迹象）'
    : `#stop 探子：泄漏了！${JSON.stringify(leakStop.slice(0, 3))}`)

  // ---- 1) 四个方向挨个试，避开"目标是墙/悬崖"的假阴性
  let best = 0
  let bestDir = null
  let finalPos = start
  for (const direction of DIRECTIONS) {
    const from = await readPos()
    if (!from) continue
    const targetX = Math.round(from.x) + direction.dx
    const targetZ = Math.round(from.z) + direction.dz
    const targetY = Math.round(from.y)
    console.log(`→ chat.send("#goto ${targetX} ${targetY} ${targetZ}")  [${direction.name}]`)
    await send(`#goto ${targetX} ${targetY} ${targetZ}`)
    const t0 = Date.now()
    let moved = 0
    while (Date.now() - t0 < 6000) {
      await sleep(300)
      const now = await readPos()
      if (!now) continue
      finalPos = now
      moved = Math.max(moved, horizontal(from, now))
      if (moved >= 2.5) break
    }
    await send('#stop')
    await sleep(400)
    const after = await readPos()
    if (after) finalPos = after
    console.log(`   位移 ${moved.toFixed(2)} 格（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    if (moved > best) {
      best = moved
      bestDir = direction.name
    }
    if (best >= 1.2) break
  }

  // ---- 2) 整轮结束后再看一次泄漏
  const leakAll = leaksSince(seqBefore)
  if (leakAll.length > 0) console.log(`⚠ 期间泄漏到服务器的 # 消息 ${leakAll.length} 条：${JSON.stringify(leakAll.slice(0, 3))}`)

  console.log(`\n最大位移 ${best.toFixed(2)} 格${bestDir ? `（${bestDir}）` : ''}，终点 ${finalPos.x.toFixed(2)}, ${finalPos.y.toFixed(2)}, ${finalPos.z.toFixed(2)}`)
  const ok = best >= 1.2 && leakAll.length === 0
  console.log(ok
    ? '✔ chat.send 能驱动 Baritone，#goto 不需要开聊天栏'
    : best >= 1.2
      ? '△ 动了，但命令同时也泄漏成了公屏聊天（需要再看 mixin/prefix 配置）'
      : '✖ 没有位移：chat.send 这条路没驱动 Baritone（回到 T 键路径）')
  exitCode = ok ? 0 : 1
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
  exitCode = 1
} finally {
  try { await send('#stop') } catch { /* 收尾尽力而为 */ }
  link.close()
}
process.exit(exitCode)
