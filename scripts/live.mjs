#!/usr/bin/env node
/**
 * 真机自检：不经过 DSH，直接用插件的连接层打一次真实 bridge（只读）。
 *
 * 用法（token 自动发现；也可显式给）：
 *   $env:SIRIUS_BRIDGE_CONFIG='<gameDir>\config\sirius_bridge.toml'
 *   node scripts/live.mjs
 *   node scripts/live.mjs --url ws://127.0.0.1:8765 --token <hex>
 *
 * 只调用感知工具（status / inventory / players / gui），不会改动世界。
 */
import { candidateTokenPaths, findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

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
  console.error('✖ 没有任何可用的 token')
  const tried = candidateTokenPaths(config)
  if (tried.length) console.error(`  试过：\n  - ${tried.join('\n  - ')}`)
  console.error('  给 gameDir / tokenPath / SIRIUS_GAME_DIR 之一，或把实例目录放进 discoverDirs。')
  process.exit(2)
}
const port = candidates.find((candidate) => candidate.port)?.port
const url = port ? `ws://127.0.0.1:${port}` : config.url
for (const candidate of candidates) {
  console.log(`token 候选 ${candidate.path}${candidate.port ? `（port ${candidate.port}）` : ''}`)
}
console.log(`连接 ${url} …`)

const link = new BridgeLink({ url, tokenCandidates: candidates, log: (m) => console.log(`  · ${m}`) })

const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const ack = await link.connect({ timeoutMs: 10_000 })
  record('hello 握手', ack?.ok === true, `protocol ${ack?.protocol_version}`)

  const status = await link.status()
  record('status 可读', status.online === true, JSON.stringify({
    inGame: status.inGame, screen: status.screen, ready: status.ready,
  }))

  const stats = await link.call('getStats', {})
  record('getStats', stats?.in_game === true,
    stats?.in_game ? `HP ${stats.health} 食 ${stats.food} ${stats.dimension} ${stats.game_mode}` : '不在游戏内')

  const inv = await link.call('inventory', {})
  const filled = (inv?.slots ?? []).filter((s) => s.item)
  record('inventory 41 槽', Array.isArray(inv?.slots) && inv.slots.length === 41,
    `非空 ${filled.length}，选中 ${inv?.selected}`)

  const players = await link.call('players', {})
  record('players', players?.in_game === true, `${players?.count} 人`)

  const caps = await link.call('capabilities/list', {})
  record('capabilities 17 工具', Array.isArray(caps) && caps.length === 17, `收到 ${caps?.length}`)
} catch (error) {
  record('连接/调用', false, error?.message ?? String(error))
} finally {
  link.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
