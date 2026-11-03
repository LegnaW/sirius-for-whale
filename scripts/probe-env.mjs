#!/usr/bin/env node
/** 环境快照：服务器里都有谁、我在哪、背包有什么、脚下是什么（只读）。 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'

const config = normalizeConfig({
  tokenPath: process.env.SIRIUS_BRIDGE_CONFIG ?? undefined,
  gameDir: process.env.SIRIUS_GAME_DIR ?? undefined,
})
const candidates = findBridgeTokenCandidates(config)
if (candidates.length === 0) { console.error('✖ 没有 token'); process.exit(2) }
const port = candidates.find((candidate) => candidate.port)?.port
const url = port ? `ws://127.0.0.1:${port}` : config.url
const link = new BridgeLink({ url, tokenCandidates: candidates, log: () => {} })

try {
  const stats = await link.call('getStats', {})
  const players = await link.call('players', {})
  const inv = await link.call('inventory', {})
  const gui = await link.call('getGuiState', {})
  const blocks = await link.call('world.query', { type: 'blocks', range: 4 })
  const entities = await link.call('world.query', { type: 'entities', range: 16 })

  console.log('== 我 ==')
  console.log(JSON.stringify({
    hp: stats.health, food: stats.food, air: stats.air, mode: stats.game_mode,
    dim: stats.dimension, pos: stats.position, yaw: stats.yaw, pitch: stats.pitch,
    xp: stats.xp_level, effects: stats.effects,
  }))
  console.log('== 在线玩家 ==')
  for (const p of players.players ?? []) {
    console.log(`  ${p.self ? '* ' : '  '}${p.name}  lat=${p.latency_ms}  ${p.gamemode ?? ''}  ${p.uuid}`)
  }
  console.log('== 背包（非空）==')
  for (const s of (inv.slots ?? []).filter((x) => x.item)) {
    console.log(`  slot ${s.slot} (${s.role})  ${s.item} ×${s.count}`)
  }
  console.log(`  selected=${inv.selected}  empty_hotbar=${JSON.stringify(inv.empty_hotbar)}`)
  console.log('== 界面 ==', JSON.stringify({ screen_open: gui.screen_open, screen_class: gui.screen_class }))
  console.log('== 脚下 4 格 ==')
  const feet = { x: Math.floor(stats.position.x), y: Math.floor(stats.position.y), z: Math.floor(stats.position.z) }
  const near = (blocks.blocks ?? []).filter((b) => Math.abs(b.x - feet.x) <= 1 && Math.abs(b.z - feet.z) <= 1 && Math.abs(b.y - feet.y) <= 2)
  for (const b of near) console.log(`  ${b.block} @ ${b.x},${b.y},${b.z}`)
  console.log(`  （range4 共 ${blocks.count} 块，truncated=${blocks.truncated}）`)
  console.log('== 16 格内实体 ==')
  for (const e of (entities.entities ?? []).slice(0, 12)) {
    console.log(`  ${e.type}${e.item ? `(${e.item}×${e.count})` : ''} @ ${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}${e.category ? ` [${e.category}]` : ''}`)
  }
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  link.close()
}
