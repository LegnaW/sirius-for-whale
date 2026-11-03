export const attackCode = `export default async function(ctx) {
  const a = ctx.args
  const call = (method, params) => ctx.api.call(method, params)
  const params = {}
  if (a.uuid != null) params.uuid = a.uuid
  if (a.name != null) params.name = a.name
  if (a.radius != null) params.radius = a.radius
  if (a.interval_ms != null) params.interval_ms = a.interval_ms
  if (a.wait_cooldown != null) params.wait_cooldown = a.wait_cooldown
  if (a.until !== 'dead') {
    params.count = a.count ?? 1
    return call('entity.attack', params)
  }
  const maxSeconds = Math.max(1, Math.min(300, Number(a.max_seconds ?? 60) || 60))
  const minHealth = Math.max(0, Math.min(20, Number(a.min_health ?? 8) || 0))
  const startedAt = Date.now()
  let attempts = 0
  let hits = 0
  let miss = 0
  let target = null
  let targetHealthBefore = null
  let targetHealthAfter = null
  let playerHealth = null
  let last = null
  const finish = (result, reason = null) => ({
    ...(last ?? {}), result, until: 'dead', attempts, hits, miss,
    elapsed_ms: Date.now()-startedAt, entity: target,
    target_health_before: targetHealthBefore, target_health_after: targetHealthAfter,
    player_health: playerHealth, max_seconds: maxSeconds, min_health: minHealth, reason,
  })
  const initial = await call('getStats', {})
  if (initial.in_game !== true) return finish('not_in_game')
  if (Number.isFinite(initial.health)) playerHealth = initial.health
  params.count = 1
  while (!ctx.signal.aborted) {
    if (Date.now()-startedAt >= maxSeconds*1000) return finish('timeout')
    if (playerHealth !== null && playerHealth <= minHealth) return finish('low_health')
    let data
    try {
      data = await call('entity.attack', params)
    } catch (error) {
      if (ctx.signal.aborted) return finish('interrupted', String(error?.message ?? error))
      throw error
    }
    last = data
    attempts += 1
    hits += Number.isFinite(data.hits) ? data.hits : (data.result === 'hit' ? 1 : 0)
    miss += Number.isFinite(data.miss) ? data.miss : 0
    if (data.entity) {
      target = { ...target, ...data.entity }
      if (Number.isFinite(data.entity.health)) {
        if (targetHealthBefore === null) targetHealthBefore = data.entity.health
        targetHealthAfter = data.entity.health
      }
    }
    if (['dead', 'gone'].includes(data.result)) return finish(data.result)
    if (data.result === 'hit' && targetHealthAfter !== null && targetHealthAfter <= 0) return finish('dead')
    if (data.result !== 'hit') return finish(data.result ?? 'unknown')
    if (!params.uuid) {
      if (!target?.uuid) return finish('target_unstable')
      params.uuid = target.uuid
      delete params.name
      delete params.radius
    }
    const stats = await call('getStats', {}).catch(() => null)
    if (stats?.in_game === false) return finish('not_in_game')
    if (Number.isFinite(stats?.health)) playerHealth = stats.health
    if (playerHealth !== null && playerHealth <= minHealth) return finish('low_health')
    const interval = Math.max(0, Math.min(5000, Number(a.interval_ms ?? 600) || 0))
    if (interval > 0) await ctx.sleep(interval)
  }
  return finish('interrupted')
}`

export const tunnelCode = `export default async function(ctx) {
  const a = ctx.args
  const height = Number(a.height)
  const width = Number(a.width)
  const depth = Number(a.depth)
  if (!Number.isInteger(height) || height < 2 || height > 16
      || !Number.isInteger(width) || width < 1 || width > 16
      || !Number.isInteger(depth) || depth < 1 || depth > 256) {
    return { result: 'invalid_dimensions', height, width, depth }
  }
  const timeoutMs = Math.max(5000, Math.min(300000, Number(a.timeout_ms ?? 120000) || 120000))
  const call = (method, params) => ctx.api.call(method, params)
  const initial = await call('getStats', {})
  const start = initial.position
  if (initial.in_game !== true || !start || !Number.isFinite(initial.yaw)) return { result: 'not_in_game' }
  const directions = [{x:0,z:1,name:'south'},{x:-1,z:0,name:'west'},{x:0,z:-1,name:'north'},{x:1,z:0,name:'east'}]
  const direction = directions[((Math.round(initial.yaw/90)%4)+4)%4]
  const startedAt = Date.now()
  let lastPosition = start
  let bestProjection = 0
  let result = 'timeout'
  let reason = null
  let finalTask = null
  const finish = () => ({
    result, reason, operation: 'baritone.tunnel', operation_id: finalTask?.operation_id ?? null,
    height, width, depth, direction: finalTask?.direction ?? direction.name,
    progress: finalTask?.progress ?? bestProjection, from: start, to: lastPosition,
    elapsed_ms: Date.now()-startedAt, allow_break: true, allow_place: false,
    region: finalTask?.region, remaining: finalTask?.remaining,
  })
  try {
    await call('baritone.settings', { allow_break: true, allow_place: false, chat_control: false })
    const started = await call('baritone.tunnel', { height, width, depth, timeout_ms: timeoutMs })
    if (started.result !== 'started') return { ...started, result: started.result ?? 'blocked' }
    finalTask = started
    while (Date.now()-startedAt < timeoutMs+2000 && !ctx.signal.aborted) {
      await ctx.sleep(400)
      const stats = await call('getStats', {}).catch(() => null)
      if (stats?.in_game === false) { result = 'not_in_game'; break }
      const position = stats?.position
      if (position) {
        const projection = (position.x-start.x)*direction.x+(position.z-start.z)*direction.z
        bestProjection = Math.max(bestProjection, projection)
        lastPosition = position
      }
      const state = await call('baritone.status', {}).catch(() => null)
      const task = state?.tunnel
      if (task) {
        finalTask = task
        await ctx.checkpoint({
          operation_id: task.operation_id, height, width, depth,
          direction: finalTask.direction ?? direction.name,
          progress: task.progress ?? bestProjection, from: start,
        })
      }
      if (task?.operation_id === started.operation_id && task.active === false) {
        result = task.result ?? 'blocked'
        reason = task.reason ?? null
        break
      }
    }
  } catch (error) {
    result = ctx.signal.aborted ? 'interrupted' : 'failed'
    reason = String(error?.message ?? error)
  } finally {
    await call('baritone.stop', {}).catch(() => {})
    await call('baritone.settings', { allow_break: false, allow_place: false }).catch(() => {})
  }
  return finish()
}`
