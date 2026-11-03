export const FOLLOW_DEFAULTS = {
  followRadius: 10,
  stallMs: 4_500,
  progressMeters: 0.75,
}

const moved = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0

export class FollowTracker {
  #status
  #baritone
  #stop
  #notify
  #log
  #now
  #config
  #follow = null
  #seq = 0

  constructor ({ status, baritone, stop, notify, log = () => {}, now = () => Date.now(), config = {} }) {
    this.#status = status
    this.#baritone = baritone
    this.#stop = stop
    this.#notify = notify
    this.#log = log
    this.#now = now
    this.#config = { ...FOLLOW_DEFAULTS, ...config }
  }

  get active () { return this.#follow !== null }

  snapshot () {
    const follow = this.#follow
    if (!follow) return null
    return {
      id: follow.id,
      owner: follow.owner,
      target: follow.target,
      follow_radius: follow.followRadius,
      distance: follow.distance,
      elapsed_ms: this.#now() - follow.startedAt,
    }
  }

  start ({ target, followRadius, owner = null }) {
    this.#follow = {
      id: `follow-${++this.#seq}`,
      target,
      followRadius: followRadius ?? this.#config.followRadius,
      owner,
      startedAt: this.#now(),
      lastProgressAt: this.#now(),
      lastPosition: null,
      distance: null,
    }
    return this.snapshot()
  }

  async cancel (reason = 'cancelled', { stop = true } = {}) {
    const follow = this.#follow
    if (!follow) return false
    this.#follow = null
    if (stop) {
      try { await this.#stop() } catch { /* 取消时连接可能已经断开 */ }
    }
    this.#log(`后台跟随取消：${reason}`)
    return true
  }

  async tick () {
    const follow = this.#follow
    if (!follow) return null
    let data
    try { data = await this.#baritone() } catch { return null }
    if (!data) return null
    const state = data.follow
    if (!state || state.active !== true || !Array.isArray(state.targets) || state.targets.length === 0) {
      return this.#finish('lost', follow)
    }

    const target = state.targets.find((entry) => entry.uuid === follow.target.uuid) ?? state.targets[0]
    let status = null
    try { status = await this.#status() } catch { /* 距离仍可使用桥端 follow 数据 */ }
    const position = status?.position ?? null
    const previousPosition = follow.lastPosition
    follow.lastPosition = position ?? previousPosition
    follow.distance = Number.isFinite(target?.distance) ? target.distance : follow.distance
    const now = this.#now()
    if (follow.distance !== null && follow.distance <= follow.followRadius + 0.5) {
      follow.lastProgressAt = now
      follow.lastPosition = position ?? follow.lastPosition
      return null
    }
    if (position && moved(previousPosition, position) >= this.#config.progressMeters) {
      follow.lastProgressAt = now
      follow.lastPosition = position
      return null
    }
    if (data?.state === 'no_path' || now - follow.lastProgressAt >= this.#config.stallMs) {
      return this.#finish('blocked', follow)
    }
    return null
  }

  async #finish (event, follow) {
    this.#follow = null
    try { await this.#stop() } catch { /* 桥已断开时保留终局事实 */ }
    const name = follow.target.name ?? follow.target.uuid ?? '?'
    const text = event === 'lost'
      ? `〔跟随丢失〕已停止跟随 ${name}：目标离开客户端可追踪范围，或跟随被其它动作取消。需要继续时先重新确认目标。`
      : `〔跟随卡住〕跟随 ${name} 超过 ${Math.round(this.#config.stallMs / 1000)} 秒没有进展，`
        + `距离约 ${follow.distance === null ? '未知' : follow.distance.toFixed(1)} 格（设定半径 ${follow.followRadius}），已停止移动。`
    try { this.#notify(text) } catch (error) { this.#log(`跟随通知失败：${error?.message ?? error}`) }
    return { event, follow: { id: follow.id, target: follow.target, owner: follow.owner }, text }
  }
}
