#!/usr/bin/env node
/**
 * 键鼠工具真机验收：`sirius_key` / `sirius_type` / `sirius_click`。
 *
 * 设计成**零净变化**：
 *   · 背包：E 开 → 点槽 0 拿起 → 点同一位置放回 → E 关；前后核对背包完全一致。
 *   · 输入：T 开聊天 → 打字 → 读回 EditBox 文本 → ESC 丢弃（不发送）。
 *
 * 直接调用插件里的工具实现（createTools），验的是真代码。
 * 用法：$env:SIRIUS_GAME_DIR='<gameDir>'; node scripts/probe-input.mjs
 */
import { findBridgeTokenCandidates, normalizeConfig } from '../src/config.mjs'
import { BridgeLink } from '../src/bridge.mjs'
import { createTools } from '../src/tools.mjs'

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
const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {} })
const tool = (name) => tools.find((item) => item.name === name)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name} ${detail}`) } else { fail += 1; console.log(`  FAIL  ${name} ${detail}`) }
}
const gui = async () => (await link.call('getGuiState', {}))
const inv = async () => (await link.call('inventory', {}))

const slotSignature = (inventory) => (inventory.slots ?? [])
  .map((slot) => `${slot.slot}:${slot.item ?? '-'}×${slot.count ?? 0}`)
  .join('|')

try {
  let status = await link.status()
  // 清场：上一次失败的运行可能把界面留在打开状态（ready=false）。
  if (status.online && status.screen) {
    console.log(`  · 清场：先关掉残留界面 ${status.screen}`)
    await tool('sirius_key').execute({ code: 'ESC' }, {})
    await sleep(700)
    status = await link.status()
  }
  console.log(`status: online=${status.online} ready=${status.ready} mode=${status.gameMode} screen=${status.screen}`)
  if (!status.ready) throw new Error('未就绪（不在世界或界面开着）')

  // ---------------------------------------------------------------- 1) E 开背包
  const beforeInv = await inv()
  await tool('sirius_key').execute({ code: 'E' }, {})
  await sleep(700)
  let screen = await gui()
  check('sirius_key E 打开背包', screen.screen_open === true && /Inventory/.test(String(screen.screen_class)), screen.screen_class)
  const slots = screen.slots ?? []
  check('getGuiState 给出槽位坐标', slots.length >= 9, `${slots.length} 槽`)

  // ---------------------------------------------------------------- 2) 点槽 0（拿起 → 放回）
  const hotbar0 = slots.find((slot) => slot.role === 'hotbar' && slot.container_slot === 0)
    ?? slots.find((slot) => slot.role === 'hotbar')
  if (!hotbar0) throw new Error('找不到快捷栏槽位')
  const at = { x: hotbar0.x + 8, y: hotbar0.y + 8 }
  console.log(`  target slot: container_slot=${hotbar0.container_slot} item=${hotbar0.item ?? '-'} gui=(${hotbar0.x},${hotbar0.y}) → click (${at.x},${at.y})`)

  const click1 = await tool('sirius_click').execute({ at, button: 'left' }, {})
  console.log(`  click#1: ${click1.summary}`)
  await sleep(700)
  const afterPickInv = await inv()
  const slot0AfterPick = (afterPickInv.slots ?? []).find((slot) => slot.slot === 0)
  console.log(`  拿起后 slot0: ${slot0AfterPick?.item ?? '（空）'}×${slot0AfterPick?.count ?? 0}`)

  const click2 = await tool('sirius_click').execute({ at, button: 'left' }, {})
  console.log(`  click#2: ${click2.summary}`)
  await sleep(700)
  const afterPutInv = await inv()

  // ---------------------------------------------------------------- 3) E 关背包 + 净零核对
  await tool('sirius_key').execute({ code: 'E' }, {})
  await sleep(600)
  screen = await gui()
  check('sirius_key E 关闭背包', screen.screen_open === false, screen.screen_class)
  check('背包净零（点拿点放后与开始时一致）',
    slotSignature(beforeInv) === slotSignature(afterPutInv),
    `${slotSignature(beforeInv).slice(0, 60)} …`)

  // ---------------------------------------------------------------- 4) 输入框
  await tool('sirius_key').execute({ code: 'T' }, {})
  await sleep(700)
  screen = await gui()
  const boxes = (screen.widgets ?? []).filter((w) => w.type === 'EditBox')
  check('sirius_key T 打开聊天框', screen.screen_open === true && boxes.length > 0, screen.screen_class)

  const text = 'sirius 键鼠测试 42'
  await tool('sirius_type').execute({ text }, {})
  await sleep(500)
  screen = await gui()
  const typed = (screen.widgets ?? []).find((w) => w.type === 'EditBox')?.text
  check('sirius_type 中文+数字注入正确', typed === text, JSON.stringify(typed))

  await tool('sirius_key').execute({ code: 'ESC' }, {})
  await sleep(600)
  screen = await gui()
  check('ESC 丢弃并关闭聊天框', screen.screen_open === false, screen.screen_class)

  console.log(`\n===== ${pass} passed, ${fail} failed =====`)
} catch (error) {
  console.error(`✖ ${error?.message ?? error}`)
  fail += 1
} finally {
  link.close()
}
process.exit(fail === 0 ? 0 : 1)
