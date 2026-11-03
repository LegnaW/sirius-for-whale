#!/usr/bin/env node
/**
 * Baritone 探针：确认客户端是否加载了 Baritone、`#goto` 是否真的能驱动移动。
 *
 * 它只做两件事：发 `#help` 看聊天回执（是否加载）、发 `#goto` 看坐标位移（是否工作），
 * 结束前 `#stop`。走真实聊天栏（T → 文本 → ENTER），因为 `chat.send` 不执行 `/` 或 `#`
 * 开头的命令（2026-10-30 真机结论）。
 *
 * 用法：
 *   $env:SIRIUS_GAME_DIR='<gameDir>'; node scripts/probe-baritone.mjs
 *   node scripts/probe-baritone.mjs --url ws://127.0.0.1:8765 --token <hex>
 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const GLFW = { T: 84, ENTER: 257, ESC: 256 }

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

async function command (text) {
  let gui = await link.call('getGuiState', {})
  if (gui?.screen_open === true) {
    await link.call('input.key', { code: GLFW.ESC })
    await sleep(350)
  }
  await link.call('input.key', { code: GLFW.T })
  await sleep(420)
  const opened = await link.call('getGuiState', {})
  if (opened?.screen_open !== true) await sleep(300)
  await link.call('input.text', { string: text })
  await sleep(200)
  await link.call('input.key', { code: GLFW.ENTER })
  await sleep(700)
}

const readPos = async () => {
  const stats = await link.call('getStats', {})
  return stats?.in_game === true ? stats.position : null
}
const horizontal = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : 0)

let exitCode = 0
try {
  const status = await link.status()
  console.log(`status: online=${status.online} inGame=${status.inGame} ready=${status.ready} screen=${status.screen}`)
  if (!status.online || !status.ready) {
    console.error('✖ 未就绪（不在世界或界面开着），先让游戏进入世界')
    process.exit(1)
  }
  await link.subscribe(['chat'])

  const start = await readPos()
  if (!start) throw new Error('读不到坐标')
  console.log(`pos0: ${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}`)

  // ---- 1) Baritone 是否加载：`#help` 应有客户端本地回执
  await command('#help')
  await sleep(900)
  const chat = link.events({ types: ['chat'], limit: 20 })
    .map((row) => row.data?.message)
    .filter(Boolean)
  console.log(`#help 回执（最近 ${chat.length} 条）：`)
  for (const line of chat.slice(-10)) console.log(`   | ${String(line).slice(0, 120)}`)
  const baritoneLoaded = chat.some((line) => /baritone|#goto|#mine|usage|command/i.test(String(line)))
  console.log(`Baritone 加载: ${baritoneLoaded ? '是（有回执）' : '未见到回执（可能未加载，或回执形态不同）'}`)

  // ---- 2) #goto 是否真的驱动移动
  const targetX = Math.round(start.x) + 10
  const targetZ = Math.round(start.z)
  console.log(`#goto ${targetX} ${targetZ} …`)
  await command(`#goto ${targetX} ${targetZ}`)
  const t0 = Date.now()
  let best = 0
  let last = start
  while (Date.now() - t0 < 25_000) {
    await sleep(400)
    const now = await readPos()
    if (!now) continue
    last = now
    best = Math.max(best, horizontal(start, now))
    if (best >= 8) break
  }
  await command('#stop')
  console.log(`位移：${best.toFixed(2)} 格（${((Date.now() - t0) / 1000).toFixed(1)}s），终点 ${last.x.toFixed(2)}, ${last.y.toFixed(2)}, ${last.z.toFixed(2)}`)

  const moved = best >= 3
  console.log(moved
    ? '✔ Baritone: OK —— #goto 真的驱动了移动'
    : '✖ Baritone: 未观察到位移（命令可能被当普通聊天发送，说明未加载）')
  exitCode = moved ? 0 : 1
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
  exitCode = 1
} finally {
  link.close()
}
process.exit(exitCode)
