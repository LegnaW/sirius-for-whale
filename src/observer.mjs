/**
 * 循环观察：**由时间 + 聊天内容共同决定"要不要看一眼屏幕"。**
 * ============================================================================
 * 用户的要求（2026-10-31）：不要"每条消息都叫醒"式的被动，也不要死盯着屏幕烧 token，
 * 而是有一个**有自己的节律**的观察循环：
 *
 *   · 刚有人说话（尤其 weak/strong）→ 看勤一点（`activeIntervalMs`，默认 5s）；
 *   · 平时 → 常量节律（`baseIntervalMs`，12s）；
 *   · 很久没人说话 → 越来越懒（`idleIntervalMs` 起，连续无事再指数拉长，封顶）；
 *   · 看一眼之后**只有"值得说"的变化才汇报**（有人走进 16 格、饿了、附近冒出敌对生物），
 *     什么都没变就保持沉默——沉默才是常态，这样"它自己看了一眼"才不等于"它要说话"。
 *
 * 和看门狗的分工：看门狗管"别人叫我"，Observer 管"我自己看看世界变了没"。
 * 汇报走同一条 steer 通道，但有独立的小时额度与静默期，避免和自主节律互相踩。
 * ============================================================================
 */

export const OBSERVE_DEFAULTS = {
  enabled: true,
  /** 刚有聊天时看得勤。 */
  activeIntervalMs: 5_000,
  /** 平时的观察节律。 */
  baseIntervalMs: 12_000,
  /** 长时间没人说话时的起点间隔（连续无事会再拉长）。 */
  idleIntervalMs: 30_000,
  /** 聊天之后多久内算"刚有人说话"。 */
  activeWindowMs: 20_000,
  /** 多久完全没动静算"闲下来了"。 */
  idleAfterMs: 180_000,
  /** 每小时最多主动汇报几次（汇报 = 叫醒模型，很贵）。 */
  maxReportsPerHour: 12,
  /** 汇报后安静这么久。 */
  quietAfterReportMs: 30_000,
  /** 玩家算"在旁边"的距离（格）。 */
  nearbyMeters: 16,
  /** 自己位移超过这么多格，位置变化本身不算"值得汇报"。 */
  moveIgnoreMeters: 24,
  /** 连续无事的退避倍数上限。 */
  maxBackoffMultiply: 6,
}

/** 人话方位/距离（给汇报用）。 */
function describe (meters) {
  if (!Number.isFinite(meters)) return '看不清位置'
  if (meters <= 3) return `就在你旁边（${meters.toFixed(1)} 格）`
  if (meters <= 8) return `朝你走过来（${meters.toFixed(0)} 格）`
  return `在 ${meters.toFixed(0)} 格外`
}

/**
 * 快照对比：返回"值得说"的变化列表（空数组 = 什么都不用说）。
 * 纯函数，单测直接喂两份快照。
 */
export function diffSnapshots (previous, current, config = OBSERVE_DEFAULTS) {
  if (!current) return []
  const notes = []
  const nearby = config.nearbyMeters

  const before = new Map((previous?.players ?? []).map((p) => [p.name, p]))
  const after = new Map((current.players ?? []).map((p) => [p.name, p]))

  for (const [name, player] of after) {
    const was = before.get(name)
    const nowClose = Number.isFinite(player.distance) && player.distance <= nearby
    const wasClose = was ? Number.isFinite(was.distance) && was.distance <= nearby : false
    if (nowClose && !wasClose) {
      notes.push(`${name} 出现了：${describe(player.distance)}`)
    }
  }
  for (const [name, was] of before) {
    if (!after.has(name) && Number.isFinite(was.distance) && was.distance <= nearby) {
      notes.push(`${name} 走开了`)
    }
  }

  if (Number.isFinite(current.food) && current.food <= 6) {
    notes.push(`你很饿（饱食 ${current.food}/20）`)
  }
  if (Number.isFinite(current.hostiles) && Number.isFinite(previous?.hostiles)
      && current.hostiles > previous.hostiles) {
    notes.push(`附近多了 ${current.hostiles - previous.hostiles} 只敌对生物`)
  }
  return notes
}

export class Observer {
  #sense
  #report
  #log
  #now
  #config
  #lastChatAt = 0
  #lastEventAt = 0
  #nextAt = 0
  #previous = null
  #silentRuns = 0
  #reportTimes = []
  #lastReportAt = 0
  #reports = 0
  #senses = 0

  constructor ({ sense, report, log = () => {}, now = () => Date.now(), config = {} } = {}) {
    this.#sense = sense
    this.#report = report
    this.#log = log
    this.#now = now
    this.#config = { ...OBSERVE_DEFAULTS, ...config }
    // 起点按"刚好过了活跃窗口"算：若设成"刚刚有活动"，首次 intervalMs() 会落到 5s 的
    // 活跃节律，与 nextAt（baseIntervalMs）自相矛盾；设成 0 又会直接掉进"很久没动"的
    // 懒节律。往前推一个活跃窗口，正好落在 base。
    this.#lastChatAt = this.#now() - this.#config.activeWindowMs
    this.#lastEventAt = this.#lastChatAt
    this.#nextAt = this.#now() + this.#config.baseIntervalMs
  }

  get stats () {
    return {
      enabled: this.#config.enabled,
      interval_ms: Math.round(this.intervalMs(this.#now())),
      next_in_ms: Math.max(0, Math.round(this.#nextAt - this.#now())),
      senses: this.#senses,
      reports: this.#reports,
      silent_runs: this.#silentRuns,
    }
  }

  /** 有人说话：进入"勤看"模式。`tier` 只影响日志与后续可扩展性。 */
  noteChat ({ tier = 'weak', at = this.#now() } = {}) {
    this.#lastChatAt = at
    if (tier === 'strong' || tier === 'weak') {
      // 有人在对我说（或可能在说）→ 立刻安排一次观察
      this.#nextAt = Math.min(this.#nextAt, at + this.#config.activeIntervalMs)
    }
  }

  /** 其它游戏事件（死亡/着火/血量低…）：同样进入勤看模式。 */
  noteEvent (at = this.#now()) {
    this.#lastEventAt = at
    this.#nextAt = Math.min(this.#nextAt, at + this.#config.activeIntervalMs)
  }

  /** 当前该用的观察间隔（纯计算，导出给单测）。 */
  intervalMs (now = this.#now()) {
    const sinceChat = now - this.#lastChatAt
    const sinceAny = now - Math.max(this.#lastChatAt, this.#lastEventAt)
    const backoff = Math.min(1 + this.#silentRuns * 0.5, this.#config.maxBackoffMultiply)
    if (sinceChat < this.#config.activeWindowMs) {
      return this.#config.activeIntervalMs
    }
    if (sinceAny > this.#config.idleAfterMs) {
      return this.#config.idleIntervalMs * backoff
    }
    return this.#config.baseIntervalMs * backoff
  }

  /** 到点了吗。 */
  due (now = this.#now()) {
    return this.#config.enabled && now >= this.#nextAt
  }

  /**
   * 一次观察：到点才真的感知；有值得说的变化才汇报。
   * @returns {Promise<{notes: string[], reported: boolean}|null>}
   */
  async tick (now = this.#now()) {
    if (!this.due(now)) return null
    let snapshot
    try {
      snapshot = await this.#sense()
    } catch (error) {
      this.#log(`观察失败：${error?.message ?? error}`)
      this.#nextAt = now + this.#config.baseIntervalMs
      return null
    }
    this.#senses += 1
    const notes = diffSnapshots(this.#previous, snapshot, this.#config)
    this.#previous = snapshot
    this.#nextAt = now + this.intervalMs(now)
    this.#silentRuns = notes.length ? 0 : this.#silentRuns + 1
    if (notes.length === 0) return { notes, reported: false }

    // 汇报 = 叫醒模型，很贵：有额度、有静默期
    this.#reportTimes = this.#reportTimes.filter((at) => now - at < 3_600_000)
    if (this.#reportTimes.length >= this.#config.maxReportsPerHour) {
      this.#log(`观察汇报超额度（${this.#reportTimes.length}/h），丢弃：${notes[0]}`)
      return { notes, reported: false }
    }
    if (this.#lastReportAt && now - this.#lastReportAt < this.#config.quietAfterReportMs) {
      return { notes, reported: false }
    }

    const heading = snapshot.position
      ? `（你在 ${Number(snapshot.position.x).toFixed(0)}, ${Number(snapshot.position.z).toFixed(0)}`
        + `${Number.isFinite(snapshot.health) ? `，血 ${Number(snapshot.health).toFixed(0)}/20` : ''}`
        + `${Number.isFinite(snapshot.food) ? `，饱食 ${Number(snapshot.food)}/20` : ''}）`
      : ''
    const text = [
      '〔观察〕我自己看了一眼，发现：',
      ...notes.map((note) => `· ${note}`),
      heading,
      '要不要处理你自己决定；没兴趣就什么都不做。',
    ].join('\n')

    try {
      this.#report(text)
      this.#reportTimes.push(now)
      this.#lastReportAt = now
      this.#reports += 1
      return { notes, reported: true, text }
    } catch (error) {
      this.#log(`观察汇报失败：${error?.message ?? error}`)
      return { notes, reported: false }
    }
  }
}
