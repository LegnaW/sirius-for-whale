#!/usr/bin/env node
/**
 * sirius_walk 真机验收：**直接调用插件里的同名工具实现**（不是另写一份替身）。
 *
 * createTools 只需要 ctx.get（attachments）与真 BridgeLink，所以能在脚本里
 * 用完全相同的工具定义跑一次真实走路：发 #goto → 坐标位移判定 → #stop。
 *
 * 用法：
 *   $env:SIRIUS_GAME_DIR='<gameDir>'; node scripts/probe-walk.mjs [--dx 8] [--dz 0]
 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'
import { createTools } from '../src/tools.mjs'

function argOf (name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const config = normalizeConfig({
  tokenPath: process.env.SIRIUS_BRIDGE_CONFIG ?? undefined,
  gameDir: process.env.SIRIUS_GAME_DIR ?? undefined,
})
const candidates = findBridgeTokenCandidates(config)
if (candidates.length === 0) {
  console.error('✖ 没有 token')
  process.exit(2)
}
const port = candidates.find((candidate) => candidate.port)?.port
const url = port ? `ws://127.0.0.1:${port}` : config.url
const link = new BridgeLink({ url, tokenCandidates: candidates, log: (m) => console.log(`  · ${m}`) })
const tools = createTools({ ctx: { get: () => undefined }, link, log: (m) => console.log(`  · ${m}`) })
const walk = tools.find((tool) => tool.name === 'sirius_walk')

const readPos = async () => (await link.call('getStats', {})).position

let exitCode = 1
try {
  const status = await link.status()
  console.log(`status: online=${status.online} ready=${status.ready} screen=${status.screen}`)
  if (!status.online || !status.ready) throw new Error('未就绪')

  const start = await readPos()
  const dx = Number(argOf('dx') ?? 8)
  const dz = Number(argOf('dz') ?? 0)
  const target = { x: Math.round(start.x + dx), z: Math.round(start.z + dz) }
  console.log(`start: ${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}`)
  console.log(`target: ${target.x}, ${target.z}（sirius_walk.execute 直调）`)

  const t0 = Date.now()
  const timeoutMs = argOf('timeout')
  const callArgs = { x: target.x, z: target.z }
  if (timeoutMs) callArgs.timeout_ms = Number(timeoutMs)
  const value = await walk.execute(callArgs, {})
  const elapsed = Date.now() - t0
  console.log(`verdict: ${value.data?.result}  (${(elapsed / 1000).toFixed(1)}s)`)
  console.log(`summary: ${value.summary}`)
  console.log(`data: ${JSON.stringify(value.data)}`)

  const after = await readPos()
  console.log(`end: ${after.x.toFixed(2)}, ${after.y.toFixed(2)}, ${after.z.toFixed(2)}`)
  exitCode = value.data?.result === 'arrived' ? 0 : 1
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
} finally {
  link.close()
}
process.exit(exitCode)
