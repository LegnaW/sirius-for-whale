export const gatherId = 'core.gather'

export function gatherArgs (raw = {}, partial = false) {
  const errors = []
  const error = (field, value, expected) => errors.push({
    field, received: value ?? null, received_type: value === undefined ? 'missing' : typeof value, expected,
    hint: typeof value === 'string' ? '数字请使用 JSON 数字，不要加引号。' : '请按 expected 修正字段。',
  })
  const integer = (field, value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) error(field, value, 'integer ' + min + '..' + max)
  }
  const point = (name, value) => {
    if (partial && value === undefined) return
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      error(name, value, '{x:integer,y:integer,z:integer}')
      return
    }
    for (const axis of ['x', 'y', 'z']) integer(name + '.' + axis, value[axis], -29999999, 29999999)
  }
  const legacy = raw.from === undefined && raw.to === undefined && ['x', 'y', 'z', 'range'].some(k => raw[k] !== undefined)
  let from = raw.from
  let to = raw.to
  if (legacy) {
    for (const axis of ['x', 'y', 'z']) {
      if (!partial || raw[axis] !== undefined) integer(axis, raw[axis], -29999996, 29999996)
    }
    const size = raw.range ?? 3
    if (![3, 5, 7].includes(size)) error('range', size, '3,5,7')
    const radius = (size - 1) / 2
    from = { x: raw.x - radius, y: raw.y - radius, z: raw.z - radius }
    to = { x: raw.x + radius, y: raw.y + radius, z: raw.z + radius }
  } else {
    point('from', from)
    point('to', to)
  }
  if ((!partial || raw.blocks !== undefined) && raw.blocks !== 'all'
      && (!Array.isArray(raw.blocks) || !raw.blocks.length || raw.blocks.length > 64
        || raw.blocks.some(id => typeof id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)))) {
    error('blocks', raw.blocks, 'required: 1..64 namespaced block IDs, or the exact string "all"')
    errors[errors.length - 1].hint = '必须明确指定方块 ID 数组；只有 blocks:"all" 才会采集全部方块。'
  }
  if (raw.allow_other_blocks !== undefined && typeof raw.allow_other_blocks !== 'boolean') error('allow_other_blocks', raw.allow_other_blocks, 'boolean')
  if (raw.max_blocks !== undefined) integer('max_blocks', raw.max_blocks, 1, 4096)
  if (raw.timeout_ms !== undefined) integer('timeout_ms', raw.timeout_ms, 5000, 280000)
  let min
  let max
  let volume = 0
  if (!errors.length && from && to && ['x', 'y', 'z'].every(axis => Number.isInteger(from[axis]) && Number.isInteger(to[axis]))) {
    min = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }
    max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) }
    volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
    if (volume > 4096) error('region', volume, 'at most 4096 blocks, endpoints included')
  }
  return {
    errors, min, max, volume, legacy, blocks: raw.blocks,
    allowOther: raw.allow_other_blocks === true,
    limit: raw.max_blocks ?? (legacy ? 12 : 4096), timeout: raw.timeout_ms ?? 180000,
  }
}

export async function gather (ctx) {
  const raw = ctx.args ?? {}
  const options = gatherArgs(raw)
  if (options.errors.length) return {
    result: 'invalid_args', errors: options.errors,
    example: { from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 68, z: 5 }, blocks: ['minecraft:oak_log'], allow_other_blocks: false },
  }
  const { min, max, volume, allowOther, limit } = options
  let phase = 'preflight'
  let rpcError = null
  const call = async (method, params = {}) => {
    try { return await ctx.api.call(method, params) } catch (error) {
      rpcError = { phase, method, params, message: String(error?.message ?? error) }
      throw error
    }
  }
  const key = p => [p.x, p.y, p.z].join(',')
  const center = p => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const reach = (feet, p) => distance({ ...feet, y: feet.y + 1.62 }, center(p))
  const read = p => call('block.get', p)
  const inside = (p, margin = 0) => ['x', 'y', 'z'].every(axis => p[axis] >= min[axis] - margin && p[axis] <= max[axis] + 1 + margin)
  const stats = async () => {
    const value = await call('getStats')
    if (!value.in_game || value.alive === false || !value.position
        || !Object.values(value.position).every(Number.isFinite)) throw new Error('玩家不在世界内、已死亡或坐标未知')
    return value.position
  }
  const deadline = Date.now() + options.timeout
  const workDeadline = deadline - 3000
  const removed = new Map()
  const knownTargets = new Map()
  const changed = new Map()
  const skipped = new Map()
  let remaining = []
  let unknown = []
  let scanComplete = false
  let scanCount = 0
  let rounds = 0
  let before = null
  let delta = null
  let reason = null
  let inventoryError = null
  let primaryError = null
  let remainingDrops = null
  let pickupError = null
  let pickupTruncated = false
  let moving = false
  const blocks = options.blocks
  let limited = false
  let currentTarget = null
  const stop = async () => {
    const value = await call('baritone.stop')
    if (value.result !== 'stopped') throw new Error('Baritone 未确认停止')
    moving = false
  }
  const walk = async (p, end) => {
    if (Date.now() >= end) return false
    moving = true
    try {
      const start = await call('baritone.goto', { ...p, allow_break: allowOther, allow_place: false })
      if (start.result !== 'started') return false
      for (let i = 0; i < 30 && Date.now() < end; i++) {
        await ctx.sleep(200)
        const feet = await stats()
        const state = await call('baritone.status')
        if (Math.floor(feet.x) === p.x && Math.floor(feet.z) === p.z && Math.abs(feet.y - p.y) <= 1) return true
        if (['no_path', 'idle', 'arrived'].includes(state.state)) return false
      }
      return false
    } finally { await stop() }
  }
  const scan = async () => {
    phase = 'scan'
    const positions = []
    for (let x = min.x; x <= max.x; x++) {
      for (let y = min.y; y <= max.y; y++) {
        for (let z = min.z; z <= max.z; z++) positions.push({ x, y, z })
      }
    }
    unknown = []
    scanCount = 0
    for (let i = 0; i < positions.length && Date.now() < workDeadline; i += 16) {
      const batch = positions.slice(i, i + 16)
      const values = await Promise.all(batch.map(read))
      for (let n = 0; n < values.length; n++) {
        const value = values[n]
        const p = batch[n]
        scanCount++
        if (value.status !== 'ok') unknown.push({ ...p, status: value.status ?? 'unknown' })
        else if (!value.air && value.breakable === true && (blocks === 'all' || blocks.includes(value.block))) knownTargets.set(key(p), { ...p, block: value.block })
        else {
          if (knownTargets.has(key(p)) && !removed.has(key(p))) changed.set(key(p), { ...p, before: knownTargets.get(key(p)).block, after: value.block })
          knownTargets.delete(key(p))
        }
      }
    }
    scanComplete = scanCount === volume
    return [...knownTargets.values()]
  }
  const dig = async target => {
    if (reach(await stats(), target) > 4.45) return { result: 'out_of_reach' }
    const timeout = Math.min(15000, workDeadline - Date.now() - 1800)
    if (timeout < 600) return { result: 'timeout' }
    const params = { x: target.x, y: target.y, z: target.z, timeout_ms: timeout, safety_checks: false, auto_tool: true }
    if (!allowOther) params.expected_block = target.block
    return call('dig', params)
  }
  const harvest = async target => {
    let outcome = await dig(target)
    if (['out_of_reach', 'blocked_sight'].includes(outcome.result)) {
      const feet = await stats()
      const stands = []
      if (allowOther) stands.push({ x: target.x, y: target.y, z: target.z })
      for (const dy of [0, -1, 1]) {
        for (const dx of [-1, 0, 1]) {
          for (const dz of [-1, 0, 1]) {
            if (dx || dy || dz) stands.push({ x: target.x + dx, y: target.y + dy, z: target.z + dz })
          }
        }
      }
      stands.sort((a, b) => distance(center(a), feet) - distance(center(b), feet))
      for (const stand of stands) {
        if (Date.now() >= workDeadline) break
        if (!allowOther) {
          const value = await read(stand)
          if (!(value.passable ?? value.air)) continue
        }
        if (!await walk(stand, Math.min(workDeadline, Date.now() + 6000))) continue
        const now = await read(target)
        if (now.status === 'ok' && now.block !== target.block) return { result: 'removed_by_path' }
        outcome = await dig(target)
        if (!['out_of_reach', 'blocked_sight'].includes(outcome.result)) break
      }
    }
    const current = await read(target)
    if (current.status === 'ok' && current.block !== target.block) return {
      result: outcome.result === 'broken' ? 'broken' : 'removed_during_action',
    }
    return outcome.result === 'broken' ? { result: 'break_unconfirmed', readback: current } : outcome
  }
  const pickup = async end => {
    phase = 'pickup'
    const tried = new Set()
    while (Date.now() < end) {
      const scan = await call('world.query', { type: 'entities', range: 32, filter: ['minecraft:item'] })
      if (!Array.isArray(scan.entities)) throw new Error('掉落物查询缺少 entities')
      pickupTruncated ||= scan.truncated === true
      remainingDrops = scan.entities.filter(e => e.uuid && e.position && inside(e.position, 2))
      const feet = await stats()
      const drop = remainingDrops.filter(e => !tried.has(e.uuid))
        .sort((a, b) => distance(a.position, feet) - distance(b.position, feet))[0]
      if (!drop) break
      tried.add(drop.uuid)
      await walk({ x: Math.floor(drop.position.x), y: Math.floor(drop.position.y), z: Math.floor(drop.position.z) }, end)
      await ctx.sleep(350)
    }
    const final = await call('world.query', { type: 'entities', range: 32, filter: ['minecraft:item'] })
    if (!Array.isArray(final.entities)) throw new Error('收尾掉落物查询缺少 entities')
    pickupTruncated ||= final.truncated === true
    remainingDrops = final.entities.filter(e => e.uuid && e.position && inside(e.position, 2))
  }
  try {
    const caps = await call('capabilities/list')
    const entries = Array.isArray(caps) ? caps : caps?.capabilities ?? caps?.result ?? []
    if (!Array.isArray(entries) || !entries.find(e => e.name === 'dig')?.input_schema?.properties?.auto_tool) {
      return { result: 'unsupported_bridge', required_capability: 'dig.auto_tool', message: '请升级到 Bridge 协议 1.17。' }
    }
    await stats()
    await stop()
    const inventory = await call('inventory')
    if (!inventory.in_game || !inventory.counts) throw new Error('无法读取采集前背包')
    before = inventory.counts
    remaining = await scan()
    while (remaining.length && Date.now() < workDeadline && removed.size < limit) {
      rounds++
      const startCount = removed.size
      const feet = await stats()
      remaining.sort((a, b) => distance(center(a), feet) - distance(center(b), feet))
      for (const target of [...remaining]) {
        if (Date.now() >= workDeadline || removed.size >= limit) break
        phase = 'dig'
        currentTarget = target
        const current = await read(target)
        if (current.status !== 'ok' || current.block !== target.block) {
          skipped.set(key(target), { ...target, reason: 'target_changed_or_unknown', state: current })
          continue
        }
        const outcome = await harvest(target)
        if (['broken', 'removed_by_path', 'removed_during_action'].includes(outcome.result)) {
          removed.set(key(target), { ...target, via: outcome.result })
          knownTargets.delete(key(target))
          skipped.delete(key(target))
          try { await pickup(Math.min(workDeadline, Date.now() + 2500)) } catch (error) { pickupError = String(error?.message ?? error) }
        } else skipped.set(key(target), { ...target, reason: outcome.result ?? 'unknown', details: outcome })
      }
      limited = removed.size >= limit
      remaining = await scan()
      if (removed.size === startCount) break
    }
    try { await pickup(deadline); pickupError = null } catch (error) { pickupError = String(error?.message ?? error) }
  } catch (error) {
    reason = String(error?.message ?? error)
    primaryError = rpcError
    if (currentTarget) skipped.set(key(currentTarget), { ...currentTarget, reason: 'action_error', message: reason })
  } finally {
    if (moving) await stop().catch(error => { reason ??= String(error?.message ?? error) })
    if (before) {
      try {
        const after = await call('inventory')
        if (!after.in_game || !after.counts) throw new Error('无法读取采集后背包')
        delta = {}
        for (const item of new Set([...Object.keys(before), ...Object.keys(after.counts)])) {
          const change = (after.counts[item] ?? 0) - (before[item] ?? 0)
          if (change) delta[item] = change
        }
      } catch (error) { inventoryError = String(error?.message ?? error) }
    }
  }
  remaining = remaining.filter(target => !removed.has(key(target)))
  const collected = Object.fromEntries(Object.entries(delta ?? {}).filter(([, count]) => count > 0))
  const uncollected = {}
  for (const drop of remainingDrops ?? []) uncollected[drop.item] = (uncollected[drop.item] ?? 0) + drop.count
  const complete = scanComplete && unknown.length === 0 && remaining.length === 0 && !reason
  const result = reason ? 'interrupted' : complete ? 'area_exhausted' : limited ? 'limit_reached'
    : Date.now() >= workDeadline ? 'timeout' : 'area_incomplete'
  return {
    result, reason, rpc_error: primaryError, region: { from: min, to: max, volume },
    blocks_filter: blocks, allow_other_blocks: allowOther,
    mined: removed.size, blocks: [...removed.values()], changed: [...changed.values()], rounds, remaining,
    skipped: [...skipped.values()].filter(p => remaining.some(q => key(q) === key(p))),
    area_complete: complete, scan: { total: volume, scanned: scanCount, complete: scanComplete, unknown },
    collected, inventory_delta: delta, inventory_verified: delta !== null, inventory_error: inventoryError,
    collected_meaning: '采集期间背包正增量，可能包括其他来源的拾取',
    uncollected, remaining_drops: remainingDrops, pickup_error: pickupError,
    pickup_scan_complete: remainingDrops !== null && !pickupTruncated && !pickupError,
    pickup_scope: '玩家附近32格内、区域周围2格内可见掉落物；可能包含原有掉落物',
    break_evidence: 'client_block_readback',
  }
}

export const gatherCode = gatherArgs.toString() + '\nexport default ' + gather.toString()
