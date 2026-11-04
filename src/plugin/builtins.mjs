import { clickAt, supportsGuiClick, keyCode, SPECIAL } from './input.mjs'
import { craftCode } from './craft.mjs'
import { inventoryCode, inventoryPluginIds } from './inventory.mjs'
import { attackCode, tunnelCode } from './combat.mjs'
import { engageCode, engageId } from './engage.mjs'
import { gatherCode, gatherId } from './gather.mjs'
import { walkGoal, walkArrived, walkDistance } from '../walk-goal.mjs'

function movementCode (operation, allowBreak) {
  return `export default async function(ctx) {
    ${walkGoal.toString()}
    ${walkArrived.toString()}
    ${walkDistance.toString()}
    const a = ctx.args
    if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || (a.y != null && !Number.isFinite(a.y))) return { result: 'invalid_target' }
    const target = { x:a.x, z:a.z, y:a.y ?? null }
    const tolerance = a.tolerance == null ? null : Math.max(0.5, Math.min(8, a.tolerance))
    const timeoutMs = Math.max(5000, Math.min(180000, a.timeout_ms ?? 60000))
    const allowBreak = ${allowBreak}
    const allowPlace = false
    const openDoors = !allowBreak && a.open_doors !== false
    const call = (method, params) => ctx.api.call(method, params)
    const stop = () => call('baritone.stop', {})
    const horizontal = (p, q) => Math.hypot(p.x-q.x, p.z-q.z)
    const startedAt = Date.now()
    let result = 'timeout'
    let reason = null
    let from = null
    let last = null
    let settled = null
    let opened = false
    try {
      const initial = await call('getStats', {})
      if (initial.in_game !== true) return { result:'not_in_game' }
      from = initial.position
      last = from
      await call('baritone.settings', {allow_break:allowBreak, allow_place:allowPlace, chat_control:false})
      const goal = walkGoal(target)
      const params = {x:goal.x, z:goal.z, allow_break:allowBreak, allow_place:allowPlace}
      if (goal.y != null) params.y = goal.y
      let settleRetries = 0
      await call('baritone.goto', params)
      let lastProgressAt = startedAt
      let progressPosition = from
      while (Date.now() - startedAt < timeoutMs) {
        if (ctx.signal.aborted) { result = 'interrupted'; break }
        await ctx.sleep(400)
        let stats
        try { stats = await call('getStats', {}) } catch { continue }
        const position = stats.position
        if (!position) continue
        last = position
        if (walkArrived(position, target, goal, tolerance)) {
          await stop()
          await ctx.sleep(450)
          settled = (await call('getStats', {}).catch(() => null))?.position ?? null
          if (settled) last = settled
          if (walkArrived(settled, target, goal, tolerance)) { result = 'arrived'; break }
          if (!settled || settleRetries++ >= 1 || Date.now() - startedAt >= timeoutMs) { result = 'off_target'; break }
          await call('baritone.goto', params)
          progressPosition = settled
          lastProgressAt = Date.now()
          continue
        }
        if (walkDistance(position, progressPosition, target.y != null) >= 0.75) {
          progressPosition = position
          lastProgressAt = Date.now()
          continue
        }
        if (Date.now() - lastProgressAt < 4500) continue
        const baritone = await call('baritone.status', {}).catch(() => null)
        if ((baritone?.state === 'calculating' || allowBreak && baritone?.state === 'pathing')
            && Date.now() - lastProgressAt < 15000) continue
        if (baritone?.state === 'arrived') { result = 'off_target'; break }
        if (walkDistance(from, position, target.y != null) < 1 || baritone?.state === 'no_path') {
          result = baritone?.state === 'no_path' ? 'no_path' : 'no_progress'
          reason = baritone?.last_line ?? null
          break
        }
        if (openDoors && !opened) {
          const world = await call('world.query', {type:'blocks', range:8})
          const pattern = /(?:^|:)(?:[a-z0-9_]*_)?(?:door|fence_gate|trapdoor)$|(?:button|lever)$/
          const doors = (world.blocks ?? []).filter((b) => pattern.test(b.block))
            .sort((p,q) => horizontal(p,position)-horizontal(q,position))
          for (const door of doors) {
            const used = await call('use', door).catch(() => null)
            if (used?.result === 'used' || used?.result === 'screen_opened') { opened = true; break }
          }
          if (opened) {
            await call('baritone.goto', params)
            progressPosition = position
            lastProgressAt = Date.now()
            continue
          }
        }
        result = 'blocked'
        break
      }
    } catch (error) {
      result = ctx.signal.aborted ? 'interrupted' : 'failed'
      reason = String(error?.message ?? error)
    } finally {
      await stop().catch(() => {})
      await call('baritone.settings', {allow_break:false, allow_place:false}).catch(() => {})
    }
    if (!['interrupted','preempted'].includes(result)) {
      await ctx.notify('${operation} ' + result + '：目标 (' + a.x + ',' + a.z + ')')
    }
    return {
      result, reason, from, to:last, settled, elapsed_ms:Date.now()-startedAt,
      target, tolerance, allow_break:allowBreak, allow_place:allowPlace, opened
    }
  }`
}

export function registerBuiltins (registry, { damageWatch = {} } = {}) {
  registry.registerBuiltin({
    id: gatherId, description: '在指定范围内采集同类方块并拾取掉落物',
    code: gatherCode,
    manifest: { mode: 'once', priority: 45, timeoutMs: 100000, description: '限量区域采集' },
  })
  registry.registerBuiltin({
    id: engageId, description: '选择一只已知敌对生物，安全接近并近战',
    code: engageCode,
    manifest: { mode: 'once', priority: 70, timeoutMs: 80000, description: '有限范围内单目标近战' },
  })
  for (const [index, id] of inventoryPluginIds.entries()) {
    const description = index === 0 ? '搬运当前界面的玩家背包槽' : '从当前打开的箱子按物品和数量存取'
    registry.registerBuiltin({
      id, description, code: inventoryCode(index === 1),
      manifest: { mode: 'once', priority: 40, timeoutMs: 60000, description },
    })
  }
  registry.registerBuiltin({
    id: 'core.open_block',
    description: '搜索并打开最近的指定方块，也接受精确坐标',
    code: `export default async function(ctx) {
      const { block, x, y, z, range = 4, face = null, hand = 'main' } = ctx.args
      let target = { x, y, z }
      if (x == null || y == null || z == null) {
        if (typeof block !== 'string' || !block) return { result: 'invalid_block' }
        const found = await ctx.api.call('world.query', { type: 'blocks', range, filter: [block] })
        if (!found.blocks?.length) return { result: 'not_found', block, range }
        target = found.blocks[0]
      }
      const used = await ctx.api.call('use', { ...target, face, hand })
      return { result: used.result, target, evidence: used }
    }`,
    manifest: { mode: 'once', priority: 40, timeoutMs: 15000, description: '打开指定或最近的方块' },
  })

  registry.registerBuiltin({
    id: 'core.damage_watch',
    enabled: damageWatch.enabled !== false,
    description: '持续受伤监听，按旧版冷却、合并和来源格式唤醒身体所有者',
    code: `export default async function(ctx) {
      const cooldownMs = Math.max(0, Number(ctx.args.damageCooldownMs ?? 30000) || 0)
      const observeWindowMs = Math.max(0, Number(ctx.args.observeWindowMs ?? 1500) || 0)
      const maxWakePerMinute = Math.max(0, Math.floor(Number(ctx.args.maxWakePerMinute ?? 6) || 0))
      const label = (entity) => {
        if (!entity || typeof entity !== 'object') return null
        const name = entity.name ?? entity.type
        if (!name) return null
        return entity.type && entity.type !== name ? name + '（' + entity.type + '）' : String(name)
      }
      const format = (d) => {
        const before = Number.isFinite(d.health_before) ? d.health_before : '?'
        const after = Number.isFinite(d.health_after) ? d.health_after : '?'
        const amount = Number.isFinite(d.amount) ? d.amount
          : (typeof before === 'number' && typeof after === 'number' ? before - after : '?')
        const attacker = label(d.attacker)
        const direct = label(d.direct_entity)
        const type = d.damage_type && d.damage_type !== 'unknown' ? String(d.damage_type) : null
        const source = [
          attacker ? '攻击者 ' + attacker : null,
          direct && direct !== attacker ? '直接伤害实体 ' + direct : null,
          type ? '类型 ' + type : null,
        ].filter(Boolean).join('，') || '未知'
        return '我受伤了：血量 ' + before + ' → ' + after + '，损失 ' + amount + '；来源：' + source
      }
      const events = await ctx.events.subscribe({ types: ['damage'] })
      const pending = []
      const wakeTimes = []
      let lastDamageAt = null
      let scheduled = false
      const flush = async () => {
        try {
          await ctx.sleep(observeWindowMs)
          const items = pending.splice(0)
          if (!items.length) return
          const now = ctx.now()
          while (wakeTimes.length && now - wakeTimes[0] >= 60000) wakeTimes.shift()
          if (wakeTimes.length >= maxWakePerMinute) {
            await ctx.log('伤害唤醒达到每分钟额度，丢弃 ' + items.length + ' 条')
            return
          }
          wakeTimes.push(now)
          const lines = items.slice(0, 5).map((text) => '· ' + text)
          if (items.length > 5) lines.push('· …另有 ' + (items.length - 5) + ' 条')
          await ctx.notify(['〔游戏·sirius〕', ...lines,
            '处理建议：先 sirius_status 看是否就绪；要看更早的事件用 sirius_events。'].join('\\n'))
        } catch (error) {
          if (!ctx.signal.aborted) await ctx.log('伤害通知失败：' + String(error?.message ?? error))
        } finally {
          scheduled = false
          if (pending.length && !ctx.signal.aborted) {
            scheduled = true
            flush()
          }
        }
      }
      for await (const event of events) {
        const now = ctx.now()
        if (lastDamageAt !== null && now - lastDamageAt < cooldownMs) continue
        lastDamageAt = now
        if (ctx.args.interruptTasks !== false) {
          const interrupted = await ctx.plugins.interrupt({ mode: 'task' }).catch(() => [])
          if (interrupted.length) pending.push('已打断 ' + interrupted.length + ' 个低优先级任务')
        }
        pending.push(format(event.data ?? {}))
        if (!scheduled) {
          scheduled = true
          flush()
        }
      }
    }`,
    manifest: {
      mode: 'service', priority: 90, timeoutMs: 0, persistent: true, description: '持续受伤唤醒',
      args: {
        damageCooldownMs: damageWatch.damageCooldownMs ?? 30_000,
        observeWindowMs: damageWatch.observeWindowMs ?? 1500,
        maxWakePerMinute: damageWatch.maxWakePerMinute ?? 6,
        interruptTasks: damageWatch.interruptTasks ?? true,
      },
    },
  })

  registry.registerBuiltin({
    id: 'core.input',
    description: '键鼠兜底：指定键值或当前/GUI 坐标点击',
    code: `export default async function(ctx) {
      const SPECIAL = ${JSON.stringify(SPECIAL)}
      ${keyCode.toString()}
      ${supportsGuiClick.toString()}
      ${clickAt.toString()}
      const call = (method, params) => ctx.api.call(method, params)
      if (ctx.args.key != null) {
        const params = { code: keyCode(ctx.args.key) }
        if (ctx.args.duration_ms != null) params.duration_ms = ctx.args.duration_ms
        if (ctx.args.modifiers) params.modifiers = ctx.args.modifiers
        return { result: 'key_sent', params, evidence: await call('input.key', params) }
      }
      if (ctx.args.click) {
        const evidence = await clickAt({ call, click: ctx.args.click })
        return { result: 'clicked', evidence }
      }
      return { result: 'invalid_input', reason: '需要 key 或 click' }
    }`,
    manifest: { mode: 'once', priority: 10, timeoutMs: 15000, description: '仅作键鼠兜底' },
  })

  registry.registerBuiltin({
    id: 'core.drop',
    description: '通过游戏动作层丢出指定背包槽位的物品，数量省略时为整组',
    code: `export default async function(ctx) {
      const params = { slot: ctx.args.slot }
      if (ctx.args.count != null) params.count = ctx.args.count
      const evidence = await ctx.api.call('inventory.drop', params)
      return { ...evidence, evidence }
    }`,
    manifest: { mode: 'once', priority: 20, timeoutMs: 15000, description: '指定槽位丢弃，省略数量则丢整组' },
  })

  registry.registerBuiltin({
    id: 'core.screenshot',
    description: '由宿主保存当前游戏截图并返回工作区路径',
    code: `export default async function(ctx) {
      const image = await ctx.screenshot(ctx.args)
      return { result: 'saved', ...image }
    }`,
    manifest: { mode: 'once', priority: 10, timeoutMs: 40000, description: '截图到会话工作区' },
  })

  registry.registerBuiltin({
    id: 'core.walk',
    description: '安全走到指定坐标，必定不破坏也不放置方块',
    code: movementCode('walk', false),
    manifest: { mode: 'task', priority: 30, timeoutMs: 180000, description: '安全寻路与卡住处理，禁止破坏/放置' },
  })

  registry.registerBuiltin({
    id: 'core.dig_to',
    description: '允许清除路径障碍并走到指定坐标，必定不放置方块',
    code: movementCode('dig_to', true),
    manifest: { mode: 'task', priority: 30, timeoutMs: 180000, description: '挖掘寻路，允许破坏，禁止放置' },
  })

  registry.registerBuiltin({
    id: 'core.follow',
    description: '使用 Baritone 跟随指定玩家，丢失或卡住时停止并提醒',
    code: `export default async function(ctx) {
      const a = ctx.args
      const uuid = typeof a.uuid === 'string' && a.uuid.trim() ? a.uuid.trim() : null
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null
      if ((uuid === null) === (name === null)) return { result: 'invalid_target', reason: 'uuid 与 name 必须二选一' }
      const radius = Number(a.follow_radius ?? 10)
      if (!Number.isInteger(radius) || radius < 1 || radius > 64) return { result: 'invalid_radius' }
      const allowBreak = a.allow_break === true
      const allowPlace = a.allow_place === true
      const call = (method, params) => ctx.api.call(method, params)
      const startedAt = Date.now()
      let result = 'interrupted'
      let reason = null
      let target = null
      let distance = null
      let lastPosition = null
      let lastProgressAt = startedAt
      try {
        const initial = await call('getStats', {})
        if (initial.in_game !== true) return { result: 'not_in_game' }
        lastPosition = initial.position
        const params = { follow_radius: radius, allow_break: allowBreak, allow_place: allowPlace }
        if (uuid) params.uuid = uuid
        else params.name = name
        const started = await call('baritone.follow', params)
        target = started.target ?? { uuid, name }
        if (started.result !== 'following') return { ...started, follow_radius: radius }
        while (!ctx.signal.aborted) {
          await ctx.sleep(2000)
          const state = await call('baritone.status', {}).catch(() => null)
          const follow = state?.follow
          if (!follow || follow.active !== true || !follow.targets?.length) {
            result = 'lost'
            reason = '目标离开追踪范围，或跟随被其它动作取消'
            break
          }
          const tracked = follow.targets.find((entry) => entry.uuid === target.uuid) ?? follow.targets[0]
          if (Number.isFinite(tracked?.distance)) distance = tracked.distance
          const stats = await call('getStats', {}).catch(() => null)
          const position = stats?.position ?? null
          const moved = position && lastPosition
            ? Math.hypot(position.x-lastPosition.x, position.y-lastPosition.y, position.z-lastPosition.z) : 0
          if (distance !== null && distance <= radius + 0.5) {
            lastProgressAt = Date.now()
          } else if (position && moved >= 0.75) {
            lastProgressAt = Date.now()
          } else if (state?.state === 'no_path' || Date.now() - lastProgressAt >= 4500) {
            result = 'blocked'
            reason = state?.last_line ?? '持续无进展'
            break
          }
          if (position) lastPosition = position
        }
      } catch (error) {
        if (!ctx.signal.aborted) { result = 'failed'; reason = String(error?.message ?? error) }
      } finally {
        await call('baritone.stop', {}).catch(() => {})
        await call('baritone.settings', { allow_break: false, allow_place: false }).catch(() => {})
      }
      if (['lost', 'blocked', 'failed'].includes(result)) {
        await ctx.notify('follow ' + result + '：' + (target?.name ?? target?.uuid ?? '?') + '；' + (reason ?? ''))
      }
      return {
        result, reason, target, distance, follow_radius: radius,
        allow_break: allowBreak, allow_place: allowPlace, elapsed_ms: Date.now()-startedAt,
      }
    }`,
    manifest: { mode: 'service', priority: 30, timeoutMs: 0, persistent: false, description: '跟随与丢失/卡住终局提醒' },
  })

  registry.registerBuiltin({
    id: 'core.craft',
    description: '按 Agent 提供的 grid 和 result 使用工作台合成并核对产物，不自动查询配方',
    code: craftCode,
    manifest: { mode: 'task', priority: 40, timeoutMs: 120000, description: '研究后执行配方，支持安全 checkpoint 续做' },
  })

  registry.registerBuiltin({
    id: 'core.attack',
    description: '按次数或直到死亡攻击同一实体，低血/超时/取消收手',
    code: attackCode,
    manifest: { mode: 'task', priority: 70, timeoutMs: 300000, description: '目标锁定战斗，不自动追怪' },
  })

  registry.registerBuiltin({
    id: 'core.tunnel',
    description: '使用 Baritone Builder 按当前朝向挖隧道，结束恢复安全设置',
    code: tunnelCode,
    manifest: { mode: 'task', priority: 30, timeoutMs: 300000, description: '隧道挖掘与终局复核' },
  })
}
