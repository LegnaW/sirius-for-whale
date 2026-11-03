/**
 * 自主节律：让 AI 在没人跟它说话的时候**自己想起来做点事**。
 * ============================================================================
 * 为什么需要它（2026-10-31，用户的原话："基本上还是相当于一个按照人的要求工作的机器人"）：
 * 看门狗只解决"有人喊我 → 醒过来"，没人喊的时候它就一直睡。于是它的行为完全由外部
 * 输入驱动——推一下动一下。
 *
 * 这里补的是**内部动机**那一半，但刻意做得很克制：
 *
 *   · 只在**真空闲**（`idleAfterMs` 内既没有人类发言、也没有其他唤醒）时才响；
 *   · 两次之间至少 `minGapMs`，每小时最多 `maxPerHour` 次；
 *   · 人类刚说过话的 `quietAfterHumanMs` 内绝不插嘴；
 *   · 报文里**明确允许它什么都不做**——否则模型会为了"有事做"而原地转圈；
 *   · 上一轮自主如果很短就结束了（说明它没真干活），下一段间隔**翻倍**，封顶
 *     `backoffMaxMs`。这条是防"烧 token 的自嗨循环"的关键。
 *
 * 驱动（drive）不是硬指令，只是给模型一个"现在可以往哪看"的提示。
 * ============================================================================
 */

export const AUTONOMY_DEFAULTS = {
  enabled: true,
  /** 连续空闲多久才考虑开口。 */
  idleAfterMs: 180_000,
  /** 两次自主之间至少隔这么久。 */
  minGapMs: 240_000,
  /** 每小时最多自主几次。 */
  maxPerHour: 4,
  /** 人类刚说过话的这段时间内不打扰。 */
  quietAfterHumanMs: 60_000,
  /** 上一轮自主"太短"就加倍间隔（说明它没真干什么）。 */
  shortTurnMs: 15_000,
  backoffFactor: 2,
  backoffMaxMs: 30 * 60_000,
}

const DRIVES = {
  hurt: '我血量偏低——先自保（吃东西 / 离开危险源 / 退到安全处）',
  hunger: '饱食偏低——找点吃的（翻箱子 / 打猎 / 耕作都行）',
  company: '有人在线——可以过去打个招呼，或者就在旁边待着做事',
  wander: '长时间无事——可以巡视一下周围、整理背包，或者练点手艺',
}

/**
 * "别人"是谁：`players` 里 `self=true` 之外的人。
 * 🔴 再加一道名字兜底：桥的 `self` 靠 profile uuid 判断，换环境/单人离线时可能标错；
 *    她自己的名字永远不该出现在"在线玩家"里（用户2026-10-31：提醒里始终说"附近有人"，
 *    那个"人"其实是她自己）。
 */
function othersOf (facts = {}) {
  const selfName = facts.selfName ? String(facts.selfName) : null
  return (facts.players ?? []).filter((player) => {
    if (player?.self === true) return false
    if (selfName && player?.name && String(player.name).toLowerCase() === selfName.toLowerCase()) return false
    return true
  })
}

/**
 * 从便宜的事实（一次 getStats + players）里挑一个驱动。
 * 纯函数：单测直接喂 facts 断言，不用起定时器。
 */
export function pickDrive (facts = {}) {
  const health = Number(facts.health ?? 20)
  const food = Number(facts.food ?? 20)
  const others = othersOf(facts)
  if (health <= 12) return 'hurt'
  if (food <= 16) return 'hunger'
  if (others.length > 0) return 'company'
  return 'wander'
}

/** 组装"自主时间"的报文（导出给单测）。 */
export function buildNotice (facts = {}, drive = 'wander') {
  const health = facts.health ?? '?'
  const maxHealth = facts.maxHealth ?? 20
  const food = facts.food ?? '?'
  const pos = facts.position
    ? `(${Number(facts.position.x).toFixed(1)}, ${Number(facts.position.y).toFixed(1)}, ${Number(facts.position.z).toFixed(1)})`
    : '?'
  const others = othersOf(facts)
  const names = others.map((player) => player.name ?? player.uuid ?? '?')
  const recent = (facts.recentEvents ?? []).slice(-3)
  const nearby = facts.nearbyPlayers ?? null

  return [
    '〔自主时间〕现在没人跟你说话。你可以自己做点事，**也可以什么都不做**——不做也是个正当选择。',
    '',
    '现在：',
    `· 血量 ${health}/${maxHealth}，饱食 ${food}/20，位置 ${pos}`,
    `· 在线玩家：${names.length ? names.join('、') : '只有你'}`,
    ...(nearby ? [`· 附近：${nearby}`] : []),
    ...(recent.length ? [`· 最近事件：${recent.join(' | ')}`] : []),
    '',
    `提示：${DRIVES[drive] ?? DRIVES.wander}`,
    '别做：不要刷屏说话；不要动别人的建筑；不要为了"有事可做"去砸方块或搭东西。',
  ].join('\n')
}

export class Autonomy {
  #deliver
  #log
  #config
  #now
  #lastHumanAt = 0
  #idleSince = 0
  #status = 'idle'
  #runningSince = 0
  #lastFireAt = 0
  #fireTimes = []
  #gapMs
  #fires = 0
  #skippedShort = 0

  constructor ({ deliver, log = () => {}, config = {}, now = () => Date.now() } = {}) {
    this.#deliver = typeof deliver === 'function' ? deliver : () => {}
    this.#log = log
    this.#now = now
    this.#config = { ...AUTONOMY_DEFAULTS, ...config }
    this.#gapMs = this.#config.minGapMs
    // 从"插件加载那一刻"开始计空闲：否则 #idleSince=0 会让第一次 tick 直接判定为
    // "已经空闲很久"，一开机就自言自语。
    this.#idleSince = this.#now()
  }

  get config () { return { ...this.#config } }

  get stats () {
    return {
      enabled: this.#config.enabled,
      status: this.#status,
      idle_ms: this.#idleSince ? this.#now() - this.#idleSince : null,
      next_gap_ms: Math.round(this.#gapMs),
      fires: this.#fires,
      skipped_short: this.#skippedShort,
    }
  }

  /** 人类说话了 / 看门狗投递了：把"空闲"重新计时，并且安静一段时间。 */
  noteHumanActivity (at = this.#now()) {
    this.#lastHumanAt = at
    if (this.#status === 'idle') this.#idleSince = at
  }

  /**
   * 宿主给的 agent 状态（`agent/status` 的 `idle` / `running`）。
   * idle 起点用来量"真空闲了多久"；running 起点用来量这一轮有多长。
   */
  noteStatus (status, at = this.#now()) {
    if (status === 'running') {
      this.#status = 'running'
      this.#runningSince = at
      return
    }
    if (this.#status === 'running' && this.#runningSince > 0) {
      this.#noteTurnEnd(at - this.#runningSince)
    }
    this.#status = 'idle'
    this.#idleSince = at
  }

  /** 一轮自主结束后调用：太短 = 没真干活 → 下一段间隔翻倍。 */
  #noteTurnEnd (turnMs) {
    if (turnMs <= 0) return
    if (turnMs < this.#config.shortTurnMs) {
      this.#skippedShort += 1
      this.#gapMs = Math.min(this.#gapMs * this.#config.backoffFactor, this.#config.backoffMaxMs)
      this.#log(`自主一轮只花了 ${Math.round(turnMs / 1000)}s（没真干活？）→ 下次间隔 ${Math.round(this.#gapMs / 1000)}s`)
    } else {
      this.#gapMs = this.#config.minGapMs
    }
  }

  /** 现在该不该自主开口？返回 `{drive}` 或 null（纯判断，副作用只有内部时间窗）。 */
  shouldFire (facts = {}, at = this.#now()) {
    if (!this.#config.enabled) return null
    if (facts.online !== true || facts.inGame !== true) return null
    if (this.#status !== 'idle') return null

    const quietSince = Math.max(this.#idleSince, this.#lastHumanAt, this.#lastFireAt)
    if (at - quietSince < this.#config.idleAfterMs) return null
    if (at - this.#lastHumanAt < this.#config.quietAfterHumanMs) return null
    if (this.#lastFireAt && at - this.#lastFireAt < this.#gapMs) return null
    this.#fireTimes = this.#fireTimes.filter((time) => at - time < 3_600_000)
    if (this.#fireTimes.length >= this.#config.maxPerHour) return null

    return { drive: pickDrive(facts) }
  }

  /** 真的开口（`shouldFire` 通过后调用）。 */
  fire (facts = {}, at = this.#now()) {
    const drive = pickDrive(facts)
    this.#lastFireAt = at
    this.#fireTimes.push(at)
    this.#fires += 1
    const text = buildNotice(facts, drive)
    try {
      this.#deliver(text)
      return { drive, text }
    } catch (error) {
      this.#log(`自主投递失败：${error?.message ?? error}`)
      return { drive, text: null }
    }
  }

  dispose () {
    this.#deliver = () => {}
  }
}
