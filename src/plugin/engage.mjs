export const engageId = 'core.engage'

async function engage (ctx) {
  const { uuid, radius = 12, min_health: minHealth = 8, max_seconds: maxSeconds = 30 } = ctx.args
  if ((uuid !== undefined && (typeof uuid !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(uuid)))
      || !Number.isInteger(radius) || radius < 4 || radius > 16
      || !Number.isFinite(minHealth) || minHealth < 1 || minHealth > 20
      || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 60) return { result: 'invalid_args' }

  const threat = new Map([
    ['minecraft:creeper', 5], ['minecraft:wither_skeleton', 5],
    ['minecraft:skeleton', 4], ['minecraft:stray', 4], ['minecraft:bogged', 4],
    ['minecraft:witch', 4], ['minecraft:pillager', 4], ['minecraft:vindicator', 4],
    ['minecraft:zombie', 2], ['minecraft:husk', 2], ['minecraft:zombie_villager', 2],
  ])
  const call = (method, params = {}) => ctx.api.call(method, params)
  const capabilities = await call('capabilities/list')
  const entries = capabilities?.capabilities ?? capabilities?.result ?? capabilities
  const names = new Set(Array.isArray(entries) ? entries.map(entry => entry?.name) : [])
  const required = ['world.query', 'getStats', 'baritone.goto', 'baritone.stop', 'entity.attack']
  const missing = required.filter(method => !names.has(method))
  if (missing.length) return { result: 'unsupported_bridge', missing }

  const distance = (a, b) => Math.hypot(a?.x - b?.x, a?.y - b?.y, a?.z - b?.z)
  let locked = uuid?.toLowerCase()
  let target = null
  let nearby = []
  let health = null
  let hits = 0
  let origin = null
  let moving = false
  let goalKey = null
  let chaseSince = null
  let result
  let reason
  let movementStopped
  const stopMovement = async () => {
    const stopped = await call('baritone.stop')
    if (stopped.result !== 'stopped') throw new Error('Baritone stop unconfirmed')
    moving = false
    goalKey = null
    movementStopped = true
  }
  const deadline = Date.now() + maxSeconds * 1000
  const run = async () => {
    while (Date.now() < deadline) {
      const stats = await call('getStats')
      if (stats.in_game !== true) return 'not_in_game'
      health = stats.health
      if (!Number.isFinite(health) || !Number.isFinite(distance(stats.position, stats.position))) return 'state_unknown'
      if (health <= minHealth) return 'low_health'
      origin ??= stats.position
      if (distance(origin, stats.position) > radius) return 'pursuit_limit'
      const scan = await call('world.query', { type: 'entities', range: radius, filter: [...threat.keys()] })
      if (!Array.isArray(scan.entities)) return 'state_unknown'
      nearby = scan.entities.filter(entity => threat.has(entity.type) && typeof entity.uuid === 'string'
        && Number.isFinite(distance(entity.position, stats.position)) && !(entity.health <= 0))
        .map(entity => ({ ...entity, distance: distance(entity.position, stats.position) }))
        .sort((a, b) => threat.get(b.type) - threat.get(a.type) || a.distance - b.distance || a.uuid.localeCompare(b.uuid))
      const seen = locked ? nearby.find(entity => entity.uuid.toLowerCase() === locked) : nearby[0]
      if (!seen) return target ? 'target_lost' : 'target_not_found'
      target = seen
      locked = seen.uuid.toLowerCase()
      if (nearby.filter(entity => entity.distance <= 5).length >= 3) return 'surrounded'
      if (distance(origin, target.position) > radius) return 'pursuit_limit'
      if (Date.now() >= deadline) break

      if (target.distance > 2.5) {
        chaseSince ??= Date.now()
        if (Date.now() - chaseSince >= 6000) return 'cannot_reach'
        const { x, y, z } = target.position
        const goal = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), allow_break: false, allow_place: false }
        const nextKey = [goal.x, goal.y, goal.z].join(',')
        if (goalKey !== nextKey) {
          moving = true
          movementStopped = false
          const started = await call('baritone.goto', goal)
          if (started.result !== 'started') return 'cannot_reach'
          goalKey = nextKey
        }
        await ctx.sleep(350)
        continue
      }
      if (moving) {
        await stopMovement()
        await ctx.sleep(250)
        continue
      }
      const attack = await call('entity.attack', { uuid: locked, count: 1, wait_cooldown: true })
      hits += attack.hits ?? 0
      if (attack.result === 'dead') return 'dead'
      if (attack.result === 'gone') return 'target_lost'
      if (attack.result !== 'hit') return attack.result ?? 'attack_unknown'
      chaseSince = null
      await ctx.sleep(350)
    }
    return 'timeout'
  }
  try {
    result = await run()
  } catch (error) {
    result = 'rpc_failed'
    reason = String(error?.message ?? error)
  } finally {
    if (moving) {
      await stopMovement().catch(() => { movementStopped = false })
    }
  }
  return { result, reason, target, hits, player_health: health, movement_stopped: movementStopped,
    nearby_threats: nearby.filter(entity => entity.uuid.toLowerCase() !== locked) }
}

export const engageCode = 'export default ' + engage.toString()
