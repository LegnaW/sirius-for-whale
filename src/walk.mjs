/**
 * 走路跟踪器：让"走路"从**阻塞调用**变成**可观察的后台任务**。
 * ============================================================================
 * 为什么（用户2026-10-31）：`sirius_walk` 阻塞最长 60 秒，主代理在等它的时候
 * 既不能聊天也不能干别的；而"停掉子代理"在阻塞调用里也只是一句空话——
 * 最多得等它跑完。
 *
 * 后台模式的做法：通过 Baritone API 出发，工具立刻返回
 * `started`；之后由这个跟踪器在后台按步长推进：
 *
 *   · 到达公差内 → 停止 + 停稳复核 → 通知一次「〔到达〕…」
 *   · 4.5 秒没进展 → 找附近的门/栅栏门用 `use` 代开；打不开就通知「〔卡住〕…」
 *   · 超时 → 通知「〔超时〕…」
 *
 * 三种终局都只通知**一次**，然后自注销。通知走 steer，所以主代理不用占回合
 * 轮询——它只需要在下一次收到消息时知道"到了/卡了"。
 * ============================================================================
 */

import { walkGoal, walkArrived, walkDistance } from './walk-goal.mjs'

export const WALK_DEFAULTS = {
  tolerance: null,
  yTolerance: 2,
  /** 多久没进展算卡住（与阻塞 walk 的判据一致）。 */
  stallMs: 4_500,
  /** 找门/栅栏门的搜索半径。 */
  doorRange: 8,
  /** 默认总预算。 */
  timeoutMs: 120_000,
}

const DOOR_RE = /(?:^|:)(?:[a-z0-9_]*_)?(?:door|fence_gate|trapdoor)$|(?:button|lever)$/

export class WalkTracker {
  #status
  #call
  #command
  #notify
  #log
  #now
  #config
  #baritone
  #walk = null
  #seq = 0

  constructor ({ status, call, command, notify, baritone = async () => null, log = () => {}, now = () => Date.now(), config = {} } = {}) {
    this.#status = status
    this.#call = call
    this.#command = command
    this.#notify = notify
    this.#baritone = baritone
    this.#log = log
    this.#now = now
    this.#config = { ...WALK_DEFAULTS, ...config }
  }

  /** 当前后台任务（没有就是 null）。 */
  snapshot () {
    const walk = this.#walk
    if (!walk) return null
    const position = walk.lastPosition
    const distance = position
      ? Math.hypot(position.x - walk.target.x, position.z - walk.target.z)
      : null
    return {
      id: walk.id,
      owner: walk.owner ?? null,
      target: walk.target,
      elapsed_ms: this.#now() - walk.startedAt,
      distance,
      vertical_distance: position && walk.target.y != null ? Math.abs(position.y - walk.target.y) : null,
      best_distance: walk.bestDistance,
      opened: walk.opened,
      resent: walk.resent,
    }
  }

  get active () { return this.#walk !== null }

  /**
   * 开始一段后台行走（`#goto` 已经由调用方发过或这里发）。
   * 有正在进行的就走 → 直接取代（Baritone 语义：新 `#goto` 覆盖旧的）。
   */
  start ({ x, z, y = null, tolerance, timeoutMs, owner = null, chatCommand }) {
    const now = this.#now()
    const goal = walkGoal({ x, y, z })
    const command = goal.y != null ? `#goto ${goal.x} ${goal.y} ${goal.z}` : `#goto ${goal.x} ${goal.z}`
    this.#walk = {
      id: `walk-${++this.#seq}`,
      target: { x, z, y },
      goal,
      settleRetries: 0,
      tolerance: tolerance ?? this.#config.tolerance,
      yTolerance: this.#config.yTolerance,
      timeoutMs: timeoutMs ?? this.#config.timeoutMs,
      owner,
      startedAt: now,
      lastProgressAt: now,
      bestDistance: Number.POSITIVE_INFINITY,
      lastPosition: null,
      startPosition: null,
      anchor: null,
      opened: 0,
      resent: 0,
      finished: false,
      chatCommand: chatCommand ?? command,
    }
    return { ...this.snapshot(), command: this.#walk.chatCommand }
  }

  /** 取消（发 `#stop` 并注销）。 */
  async cancel (reason = 'cancelled') {
    const walk = this.#walk
    if (!walk) return false
    this.#walk = null
    try { await this.#command('#stop', { waitMs: 300 }) } catch { /* 已经停了 */ }
    this.#log(`后台走路取消：${reason}`)
    return true
  }

  /**
   * 推进一步。返回终局事件（或 null）。
   * @returns {Promise<null | {event: string, walk: object, text?: string}>}
   */
  async tick () {
    const walk = this.#walk
    if (!walk) return null
    const now = this.#now()

    let status
    try {
      status = await this.#status()
    } catch {
      return null
    }
    if (this.#walk !== walk) return null
    if (status?.online !== true || status?.inGame !== true) {
      return this.#finish('left_game', walk, '（不在游戏里了，走路任务作废）')
    }
    const position = status.position
    if (!position) return null
    walk.lastPosition = position
    if (!walk.startPosition) walk.startPosition = { x: position.x, y: position.y, z: position.z }
    const distance = Math.hypot(position.x - walk.target.x, position.z - walk.target.z)
    const includeY = walk.target.y != null
    walk.bestDistance = Math.min(walk.bestDistance, distance)

    // 进展判定：相对"上一次记进度时的落点"挪了 ≥0.75 格才算有进展
    if (!walk.anchor) walk.anchor = { x: position.x, y: position.y, z: position.z }
    if (walkDistance(position, walk.anchor, includeY) >= 0.75) {
      walk.anchor = { x: position.x, y: position.y, z: position.z }
      walk.lastProgressAt = now
    }
    const totalMoved = walk.startPosition
      ? Math.hypot(position.x - walk.startPosition.x, includeY ? position.y - walk.startPosition.y : 0, position.z - walk.startPosition.z)
      : 0

    if (walkArrived(position, walk.target, walk.goal, walk.tolerance, walk.yTolerance)) {
      try { await this.#command('#stop', { waitMs: 300 }) } catch { /* ignore */ }
      // `#stop` 会滑 3 格左右（真机），复核一次停稳位置再汇报
      let settled = null
      try {
        await new Promise((resolve) => setTimeout(resolve, 450))
        const again = await this.#status()
        if (again?.position) settled = again.position
      } catch { /* ignore */ }
      if (this.#walk !== walk) return null
      if (!walkArrived(settled, walk.target, walk.goal, walk.tolerance, walk.yTolerance)) {
        if (settled) walk.lastPosition = settled
        if (settled && walk.settleRetries++ === 0 && this.#now() - walk.startedAt < walk.timeoutMs) {
          walk.anchor = settled
          walk.lastProgressAt = this.#now()
          await this.#command(walk.chatCommand, { waitMs: 400 })
          return null
        }
        return this.#finish('off_target', walk, '〔偏离〕停稳后未确认到达目标。')
      }
      walk.lastPosition = settled
      const settledDistance = Math.hypot(settled.x - walk.target.x, settled.z - walk.target.z)
      const elapsed = ((now - walk.startedAt) / 1000).toFixed(1)
      return this.#finish(
        'arrived',
        walk,
        `〔到达〕已到 (${settled.x.toFixed(1)}, ${settled.z.toFixed(1)})，距目标 ${settledDistance.toFixed(2)} 格，用时 ${elapsed}s`
          + `${walk.opened ? `；途中开了 ${walk.opened} 扇门` : ''}。路已经走完，你可以接手做别的了。`,
      )
    }

    if (now - walk.startedAt >= walk.timeoutMs) {
      try { await this.#command('#stop', { waitMs: 300 }) } catch { /* ignore */ }
      return this.#finish(
        'timeout',
        walk,
        `〔超时〕${Math.round(walk.timeoutMs / 1000)}s 没走到 (${walk.target.x}, ${walk.target.z})，最后停在 ${distance.toFixed(1)} 格外（已发 #stop）`,
      )
    }

    if (now - walk.lastProgressAt < this.#config.stallMs) return null

    // 一步都没动过 → 多半是 Baritone 没装 / 命令没送进去，跟"被挡住"不是一回事。
    // 1.6 起先问一句 Baritone：它自报 no_path 就是"算不出路"（目标不可达/被封住），
    // 教学话术必须和"没装 Baritone"分开，否则模型会一直重发同一个目标。
    const bari = await Promise.resolve().then(() => this.#baritone()).catch(() => null)
    if (this.#walk !== walk) return null
    if (bari?.state === 'calculating' && now - walk.lastProgressAt < 15000) return null
    if (bari?.state === 'arrived') {
      try { await this.#command('#stop', { waitMs: 300 }) } catch { /* ignore */ }
      return this.#finish('off_target', walk, '〔偏离〕寻路已结束，实际位置偏离目标。')
    }
    if (totalMoved < 1 || bari?.state === 'no_path') {
      try { await this.#command('#stop', { waitMs: 300 }) } catch { /* ignore */ }
      const noPath = bari?.state === 'no_path'
      return this.#finish(
        noPath ? 'no_path' : 'no_progress',
        walk,
        noPath
          ? `〔没路〕Baritone 算不出到 (${walk.target.x}, ${walk.target.z}) 的路径（${String(bari?.last_line ?? '').slice(0, 60) || 'no path'}）`
            + '——目标可能在实心方块里或四面封死，换个落点再试。'
          : `〔没动〕前往 (${walk.target.x}, ${walk.target.z}) 后一步没动（${((now - walk.startedAt) / 1000).toFixed(1)}s）`
            + '——检查客户端是否装了 Baritone API 构建。',
      )
    }

    // 卡住了：找附近的门/栅栏门代开
    const doors = await this.#nearbyDoors(position)
    if (doors.length > 0) {
      const door = doors[0]
      try {
        const result = await this.#call('use', { x: door.x, y: door.y, z: door.z })
        if (result?.result === 'used' || result?.result === 'screen_opened') {
          walk.opened += 1
          walk.lastProgressAt = now
          try { await this.#command(walk.chatCommand, { waitMs: 400 }) } catch { /* ignore */ }
          return null
        }
      } catch { /* 够不着 / 界面开着：换下一个候选 */ }
    }
    try { await this.#command('#stop', { waitMs: 300 }) } catch { /* ignore */ }
    const nearest = doors[0]
    return this.#finish(
      'blocked',
      walk,
      `〔卡住〕停在 (${position.x.toFixed(1)}, ${position.z.toFixed(1)})，距目标 ${distance.toFixed(2)} 格`
        + (nearest
          ? `；最近的可开方块 ${nearest.block} 在 (${nearest.x}, ${nearest.y}, ${nearest.z})，试过没打开`
          : '；8 格内没有门/栅栏门/活板门/按钮')
        + '（已发 #stop）。要砸过去可以重发 sirius_walk 时带 allow_break=true。',
    )
  }

  async #nearbyDoors (from) {
    let data
    try {
      data = await this.#call('world.query', { type: 'blocks', range: this.#config.doorRange })
    } catch {
      return []
    }
    const blocks = Array.isArray(data?.blocks) ? data.blocks : []
    return blocks
      .filter((block) => typeof block?.block === 'string' && DOOR_RE.test(block.block))
      .map((block) => ({ ...block, distance: Math.hypot(block.x - from.x, block.z - from.z) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 3)
  }

  #finish (event, walk, text) {
    this.#walk = null
    try {
      this.#notify(text)
    } catch (error) {
      this.#log(`走路通知失败：${error?.message ?? error}`)
    }
    return { event, walk: { id: walk.id, target: walk.target, owner: walk.owner }, text }
  }
}
