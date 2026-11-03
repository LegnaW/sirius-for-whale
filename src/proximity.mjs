/**
 * 距离线索：把"谁在跟我说话"从名字升级成"名字 + 他离我多远"。
 * ============================================================================
 * 为什么需要（用户2026-10-31）：同样一句"过来一下"——
 *   · 站在你旁边说 → 他就是在跟你说话，必须回应；
 *   · 隔着 40 格在群里说 → 很可能是在叫别人；
 *   · 隔着一整个地图说 → 根本没指望你能听见。
 * 纯文本判断永远分不清这三种。距离是最便宜的空间线索。
 *
 * 数据从哪来：`world.query {type:'entities'}` 在**客户端可见范围**内返回
 * `{uuid, name, type, position}`（真机确认 players 也在里面），再与自己的
 * `getStats.position` 求水平距离。
 *
 * 🔴 **看得见才有距离**：超出客户端实体追踪范围的玩家根本不在列表里，
 *    这时只能说"看不清"（`unknown`），不能猜一个数。`formatDistance()` 会
 *    把这件事说清楚，别让模型以为"看不见 = 很远"。
 * ============================================================================
 */

export const PROXIMITY_DEFAULTS = {
  /** 查询半径（格）。客户端实体追踪范围大约就是这么多，再大也拿不到。 */
  range: 48,
  /** 快照缓存时长：一次查询服务多条聊天/多个判断。 */
  ttlMs: 3000,
}

/** 距离分段（给规则和提示词用，比裸数字好讲）。 */
export function distanceBand (meters) {
  if (!Number.isFinite(meters)) return 'unknown'
  if (meters <= 3) return 'touch'
  if (meters <= 12) return 'near'
  if (meters <= 32) return 'mid'
  return 'far'
}

/** 人话版距离。`null`/NaN = 客户端看不见这个人。 */
export function formatDistance (meters) {
  if (!Number.isFinite(meters)) return '看不清（不在客户端可见范围）'
  if (meters <= 3) return `就贴着你（${meters.toFixed(1)} 格）`
  if (meters <= 12) return `离你 ${meters.toFixed(0)} 格`
  if (meters <= 32) return `离你 ${meters.toFixed(0)} 格（有点远）`
  return `离你 ${meters.toFixed(0)} 格（很远）`
}

/** 水平距离（MC 里"够不够得着/听不听得见"看水平距离就够，竖直差单独说）。 */
export function horizontalDistance (a, b) {
  if (!a || !b) return Number.NaN
  const dx = Number(a.x) - Number(b.x)
  const dz = Number(a.z) - Number(b.z)
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return Number.NaN
  return Math.hypot(dx, dz)
}

/** "几乎跟自己重合"的阈值：自己那个实体就长在自己脚上，距离恒等于 0。 */
export const SELF_EPSILON = 0.35

/**
 * 这个实体是不是**她自己**。
 * ============================================================================
 * 🔴 真机（2026-10-31，用户报）：`world.query{entities}` 的玩家列表里包含她自己，
 *    于是"附近有人"永远报她自己的名字，自主时间的公司线索完全失效。
 *
 * 三条判据，按可靠性降序（身份在离线/服务器之间会变，所以三条都留）：
 *   1. uuid 相等 —— 最硬，但单机离线 uuid ≠ 服务器正版 uuid，重连也会变；
 *   2. 名字相等 —— 换个服务器名字不变，作为 uuid 失效时的兜底；
 *   3. 距离 < {@link SELF_EPSILON} —— 身份完全不知道时（还没拿到 `players.self`）用这个：
 *      自己的实体就长在自己脚上，距离恒为 0；别人几乎不可能精确站在同一点。
 *      代价：身份未知时，一个真的贴脸站着的玩家会被误判成自己——可接受，且只要
 *      拿到过一次身份就不再走这条路。
 * ============================================================================
 */
export function isSelfEntity (entity, origin, self = null) {
  const selfUuid = self?.uuid ? String(self.uuid) : null
  const selfName = self?.name ? String(self.name) : null
  if (selfUuid && entity?.uuid && String(entity.uuid) === selfUuid) return true
  if (selfName && entity?.name && String(entity.name).toLowerCase() === selfName.toLowerCase()) return true
  if (selfUuid || selfName) return false
  const distance = horizontalDistance(entity?.position, origin)
  return Number.isFinite(distance) && distance < SELF_EPSILON
}

/**
 * 玩家距离快照。注入 `query`（返回实体列表）与 `stats`（返回自己的位置），
 * 使其可单测——不碰网络。
 */
export class Proximity {
  #query
  #stats
  #self
  #now
  #config
  #log
  #snapshot = null
  #at = 0
  #inflight = null
  #failures = 0

  constructor ({ query, stats, self = () => null, log = () => {}, now = () => Date.now(), config = {} } = {}) {
    this.#query = query
    this.#stats = stats
    this.#self = self
    this.#log = log
    this.#now = now
    this.#config = { ...PROXIMITY_DEFAULTS, ...config }
  }

  get stats () {
    return {
      age_ms: this.#at ? this.#now() - this.#at : null,
      players: this.#snapshot?.players?.length ?? 0,
      failures: this.#failures,
    }
  }

  /** 快照是否还新鲜。 */
  get fresh () {
    return Boolean(this.#snapshot) && this.#now() - this.#at < this.#config.ttlMs
  }

  /**
   * 刷新快照（同一时刻只会有一个在飞）。
   * @param {boolean} force 忽略 TTL 强制刷新
   */
  async refresh (force = false) {
    if (!force && this.fresh) return this.#snapshot
    if (this.#inflight) return this.#inflight
    this.#inflight = (async () => {
      try {
        const [entities, me] = await Promise.all([this.#query(this.#config.range), this.#stats()])
        const origin = me?.position ?? me
        // 自己的身份（uuid/名字）可能还不知道：拿不到就返回 null，交给距离兜底
        let self = null
        try { self = this.#self() ?? null } catch { /* 身份查询失败不该拖垮快照 */ }
        const players = []
        let mobs = 0
        for (const entity of Array.isArray(entities) ? entities : []) {
          const type = String(entity?.type ?? '')
          if (type === 'minecraft:player') {
            if (isSelfEntity(entity, origin, self)) continue // 附近的人不包括她自己
            const distance = horizontalDistance(entity.position, origin)
            players.push({
              name: entity.name ?? entity.uuid ?? '?',
              uuid: entity.uuid ?? null,
              distance,
              band: distanceBand(distance),
              dy: Number(origin?.y ?? 0) - Number(entity?.position?.y ?? 0),
            })
            continue
          }
          mobs += 1
        }
        players.sort((left, right) => left.distance - right.distance)
        this.#snapshot = { players, mobs, at: this.#now() }
        this.#at = this.#now()
        this.#failures = 0
        return this.#snapshot
      } catch (error) {
        this.#failures += 1
        this.#log(`距离快照失败（第 ${this.#failures} 次）：${error?.message ?? error}`)
        return this.#snapshot
      } finally {
        this.#inflight = null
      }
    })()
    return this.#inflight
  }

  /** 同步读：从上一份快照里找这个人（不触发查询）。 */
  lookup (nameOrUuid) {
    const key = String(nameOrUuid ?? '')
    const player = this.#snapshot?.players?.find(
      (candidate) => candidate.name === key || candidate.uuid === key,
    )
    if (!player) return { distance: Number.NaN, band: 'unknown', text: formatDistance(Number.NaN) }
    return {
      distance: player.distance,
      band: player.band,
      text: formatDistance(player.distance),
      dy: player.dy,
    }
  }

  /** 人话一句话：给自主时间的"谁在附近"用。 */
  describeNearby (limit = 3) {
    const players = (this.#snapshot?.players ?? [])
      .filter((player) => Number.isFinite(player.distance))
      .slice(0, limit)
    if (players.length === 0) return null
    return players.map((player) => `${player.name}（${formatDistance(player.distance)}）`).join('、')
  }
}
