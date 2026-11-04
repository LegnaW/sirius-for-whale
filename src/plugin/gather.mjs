export const gatherId = 'core.gather'

export async function gather (ctx) {
  const { x, y, z, range = 3, max_blocks: limit = 12 } = ctx.args
  if (![x, y, z].every(value => Number.isInteger(value) && Math.abs(value) <= 29999996)
      || ![3, 5, 7].includes(range) || !Number.isInteger(limit) || limit < 1 || limit > 32) return { result: 'invalid_args' }

  const call = (method, params = {}) => ctx.api.call(method, params)
  const caps = await call('capabilities/list')
  const entries = Array.isArray(caps) ? caps : caps?.capabilities ?? caps?.result ?? []
  const digSchema = Array.isArray(entries) ? entries.find(entry => entry?.name === 'dig')?.input_schema : null
  if (!digSchema?.properties?.expected_block) {
    return { result: 'unsupported_bridge', required_capability: 'dig.expected_block' }
  }

  const key = ({ x, y, z }) => [x, y, z].join(',')
  const offset = (p, x, y, z) => ({ x: p.x + x, y: p.y + y, z: p.z + z })
  const cell = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const center = (p) => offset(p, 0.5, 0.5, 0.5)
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const reach = (feet, p) => distance(offset(feet, 0, 1.62, 0), center(p))
  const read = (p) => call('block.get', p)
  const stats = async () => {
    const state = await call('getStats')
    if (state.in_game !== true || !state.position
        || ![state.position.x, state.position.y, state.position.z, state.health].every(Number.isFinite)
        || state.health <= 8) throw new Error('玩家状态未知或生命值过低')
    return state.position
  }
  const safeCell = async (p) => {
    const foot = await read(p)
    if ((foot.passable ?? foot.air) !== true) return false
    const head = await read(offset(p, 0, 1, 0))
    if ((head.passable ?? head.air) !== true) return false
    return (await read(offset(p, 0, -1, 0))).safe_support === true
  }

  const standingCell = async (feet) => {
    const p = cell(feet)
    if (feet.y - p.y < 0.1) return p
    const base = await read(p)
    if (base.safe_support && Math.abs(feet.y - p.y - base.support_height) <= 0.15) return offset(p, 0, 1, 0)
    return p
  }

  const seed = { x, y, z }
  const initial = await stats()
  if (distance(initial, seed) > 12) return { result: 'seed_too_far' }
  const seedState = await read(seed)
  if (seedState.status !== 'ok') return { result: 'seed_unknown' }
  if (!Object.hasOwn(seedState, 'safe_support')) return { result: 'unsupported_bridge', required_capability: 'block.get.safe_support' }
  if (seedState.air || !seedState.breakable) return { result: 'invalid_seed', block: seedState.block }
  const seedBlock = seedState.block
  const navigation = await call('baritone.status')
  const idle = (state) => ['idle', 'arrived', 'no_path'].includes(state)
  if (!idle(navigation.state)) return { result: 'movement_busy' }

  const deadline = Date.now() + 85000
  const digDeadline = deadline - 6000
  const mined = []
  const skipped = new Map()
  const retry = []
  const reported = new Map()
  const observed = new Map()
  const collected = {}
  const uncollected = {}
  let unknown = 0
  let moving = false
  let reason
  let pickupUncertain = false

  const stop = async () => {
    const value = await call('baritone.stop')
    if (value.result !== 'stopped') throw new Error('移动停止未确认')
    moving = false
  }
  const walk = async (to, end) => {
    if (Date.now() >= end || !await safeCell(to)) return false
    const from = await stats()
    if (distance(from, center(to)) > 8) return false
    if (key(await standingCell(from)) === key(to)) return true
    moving = true
    try {
      const started = await call('baritone.goto', { ...to, allow_break: false, allow_place: false })
      if (started.result !== 'started') return false
      const until = Math.min(end, Date.now() + 2400)
      for (let i = 0; i < 12 && Date.now() < until; i++) {
        await ctx.sleep(200)
        if (key(await standingCell(await stats())) === key(to)) return await safeCell(to)
        if (idle((await call('baritone.status')).state)) break
      }
      return false
    } finally {
      await stop()
    }
  }
  const standsAround = (p, feet) => {
    const stands = []
    for (const dy of [0, -1, 1]) {
      for (const dx of [-1, 0, 1]) {
        for (const dz of [-1, 0, 1]) {
          const stand = offset(p, dx, dy, dz)
          if (distance(feet, center(stand)) <= 8) stands.push(stand)
        }
      }
    }
    return stands.sort((a, b) => distance(feet, center(a)) - distance(feet, center(b)))
  }
  const tryDig = async (p, feet, end) => {
    const current = await read(p)
    if (current.status !== 'ok') return { result: 'target_unknown' }
    if (current.block !== seedBlock) return { result: 'target_changed' }
    if (reach(feet, p) > 4.45) return { result: 'out_of_reach' }
    if (!await safeCell(await standingCell(feet))) return { result: 'unsafe_stand' }
    const timeout = Math.min(3500, end - Date.now() - 500)
    if (timeout < 600) return { result: 'timeout' }
    return call('dig', { ...p, expected_block: seedBlock, timeout_ms: timeout })
  }
  const reposition = new Set(['out_of_reach', 'blocked_sight', 'unsafe_stand', 'unsafe_support'])
  const harvest = async (p, feet) => {
    const end = Math.min(digDeadline, Date.now() + 8500)
    let answer = await tryDig(p, feet, end)
    if (!reposition.has(answer.result)) return answer
    let attempts = 0
    for (const stand of standsAround(p, feet)) {
      if (Date.now() >= end || attempts >= 3) break
      if (key(stand) === key(cell(feet)) || key(offset(stand, 0, -1, 0)) === key(p)) continue
      if (reach(offset(stand, 0.5, 0, 0.5), p) > 4.45 || !await safeCell(stand)) continue
      attempts++
      if (!await walk(stand, end)) continue
      answer = await tryDig(p, await stats(), end)
      if (!reposition.has(answer.result)) break
    }
    return answer
  }
  const items = async () => {
    const scan = await call('world.query', { type: 'entities', range: 8, filter: ['minecraft:item'] })
    return (scan.entities ?? []).filter(e => e.uuid && e.position && typeof e.item === 'string')
  }
  const counts = async () => {
    const value = await call('inventory')
    if (value.in_game !== true || !value.counts) throw new Error('背包状态未知')
    return value.counts
  }
  const nearMined = (drop) => mined.some(p => distance(drop.position, center(p)) <= 2.5)
  const pickup = async (before, prior) => {
    await ctx.sleep(450)
    const fresh = (entries) => entries.filter(drop => !prior.has(drop.uuid) && nearMined(drop))
    const attempted = new Set()
    for (let i = 0; i < 4 && Date.now() < deadline; i++) {
      const feet = await stats()
      const drops = fresh(await items())
      for (const drop of drops) observed.set(drop.uuid, drop)
      const drop = drops.filter(entry => !attempted.has(entry.uuid))
        .sort((a, b) => distance(feet, a.position) - distance(feet, b.position))[0]
      if (!drop) break
      attempted.add(drop.uuid)
      for (const stand of standsAround(cell(drop.position), feet)) {
        const body = offset(stand, 0.5, 0.6, 0.5)
        if (Math.abs(stand.y - drop.position.y) > 1 || distance(body, drop.position) > 0.9) continue
        if (await walk(stand, deadline)) {
          await ctx.sleep(350)
          break
        }
      }
    }
    const after = await counts()
    const seenCounts = new Map()
    for (const drop of observed.values()) seenCounts.set(drop.item, (seenCounts.get(drop.item) ?? 0) + drop.count)
    const known = new Set([...reported.keys(), ...seenCounts.keys()])
    for (const item of known) {
      const gain = Math.max(0, (after[item] ?? 0) - (before[item] ?? 0))
      const seen = Math.max(reported.get(item) ?? 0, seenCounts.get(item) ?? 0)
      if (gain) collected[item] = Math.min(gain, seen)
      if (seen > gain) uncollected[item] = seen - gain
    }
    pickupUncertain = Object.keys(after).some(item => after[item] - (before[item] ?? 0) > (collected[item] ?? 0))
  }

  let timedOut = false
  try {
    const radius = (range - 1) / 2
    const queue = []
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Date.now() >= digDeadline) return { result: 'timeout', block: seedBlock, mined: 0 }
          const p = offset(seed, dx, dy, dz)
          const entry = await read(p)
          if (entry.status === 'unloaded' || entry.in_game === false) unknown++
          else if (entry.block === seedBlock) queue.push(p)
        }
      }
    }
    const before = await counts()
    const prior = new Set((await items()).map(e => e.uuid))
    const tier = (p, feet) => reach(feet, p) <= 4.45 ? 0 : Math.abs(p.y - feet.y) <= 2 ? 1 : 2
    const run = async (pending, allowRetry) => {
      while (pending.length && mined.length < limit && Date.now() < digDeadline) {
        const feet = await stats()
        pending.sort((a, b) => tier(a, feet) - tier(b, feet) || distance(feet, center(a)) - distance(feet, center(b)))
        const p = pending.shift()
        const outcome = await harvest(p, feet)
        if (outcome.result === 'broken') {
          const check = await read(p)
          if (check.status === 'ok' && check.block !== seedBlock) {
            mined.push(p)
            skipped.delete(key(p))
            for (const drop of outcome.drops ?? []) reported.set(drop.item, (reported.get(drop.item) ?? 0) + drop.count)
            continue
          }
          outcome.result = 'break_unconfirmed'
        }
        const reason = outcome.result ?? 'unknown'
        skipped.set(key(p), { ...p, reason })
        if (allowRetry && reposition.has(reason)) retry.push({ p, after: mined.length })
      }
    }
    await run(queue, true)
    if (mined.length < limit) await run(retry.filter(entry => entry.after < mined.length).map(entry => entry.p), false)
    timedOut = Date.now() >= digDeadline && mined.length < limit
    if (mined.length) await pickup(before, prior)
  } catch (error) {
    reason = String(error?.message ?? error)
  } finally {
    if (moving) await stop().catch(() => { reason ??= '移动停止未确认' })
  }
  const result = reason ? 'interrupted' : mined.length >= limit ? 'limit_reached'
    : timedOut ? 'timeout' : skipped.size || unknown ? 'area_incomplete' : 'area_exhausted'
  return { result, reason, block: seedBlock, mined: mined.length, blocks: mined, collected, uncollected,
    break_evidence: 'client_block_readback', pickup_evidence: 'inventory_delta',
    uncertain_pickups: Number(pickupUncertain), skipped: [...skipped.values()], unknown_blocks: unknown }
}

export const gatherCode = 'export default ' + gather.toString()
