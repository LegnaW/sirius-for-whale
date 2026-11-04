/**
 * sirius-bridge 的 WS 客户端：握手、RPC 配对、事件缓冲、就绪判定。
 * ============================================================================
 * 协议（见 Sirius-Minecraft `docs_agent/sirius-technical.md` §8.2）：
 *   → {"type":"hello","token":"…","protocol_version":"1.4"}
 *   ← {"type":"hello_ack","ok":true,"protocol_version":"1.4"}
 *   → {"type":"request","id":"…","method":"getStats","params":{}}
 *   ← {"type":"response","id":"…","result":{…}} | {"type":"response","id":"…","error":{code,message}}
 *   ← {"type":"notification","event":"chat","data":{…},"timestamp":…,"seq":n}
 *
 * 工程纪律：
 *   · **懒连接**：第一次工具调用才连；连不上就把错误交给调用方，不吞。
 *   · **单连接**：一台真实客户端只有一个 bridge 端口，插件进程内只维护一条。
 *   · **多 token 候选**：启动器版本隔离下每台实例各有 token，错的那个会被
 *     bridge 以 close 1008 拒掉——逐个换着试；**一个都没有时不发 hello**，
 *     否则"空 token 被拒"会被误读成"token 不对"（2026-10-31 首次接线的坑）。
 *   · **超时与取消**：每个 RPC 都有截止时间；`signal` 只放弃等待，**不硬杀**游戏侧
 *     动作（游戏主线程不可抢占），这一点在工具描述里对模型明确。
 *   · **零依赖**：用 Node 22+ 的全局 WebSocket（`globalThis.WebSocket`）。
 * ============================================================================
 */

/** bridge 返回的错误（-32010 限频 / -32012 权限 / -32602 参数 …）或本层错误。 */
export class SiriusError extends Error {
  constructor (message, { code, method, data, hint } = {}) {
    super(message)
    this.name = 'SiriusError'
    this.code = code
    this.method = method
    this.data = data
    this.hint = hint
  }
}

const HELLO_PROTOCOL = '1.4'
const CLOSE_POLICY = 1008

const isOpen = (ws) => ws && ws.readyState === 1

function parseFrame (raw) {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object' && typeof raw.toString === 'function') {
      raw = raw.toString()
    } else return null
  }
  if (!raw.startsWith('{')) return null
  try {
    const frame = JSON.parse(raw)
    return frame && typeof frame === 'object' ? frame : null
  } catch {
    return null
  }
}

/** 旧看门狗的默认集合：高频原始事件只由调用方显式订阅。 */
export const EVENT_KINDS = ['chat', 'gui_open', 'gui_close', 'death', 'damage', 'fire', 'health_low', 'drown', 'screenshot']

/** bridge 协议 1.11 的原始核心事件。 */
export const CORE_EVENT_KINDS = [
  'block_update', 'entity_spawn', 'entity_gone', 'entity_hurt', 'entity_death', 'item_pickup',
  'player_join', 'player_leave', 'window_open', 'window_close', 'slot_update',
  'held_item_changed', 'connection_state', 'baritone_state',
]

export class BridgeLink {
  #url
  #candidates
  #timeoutMs
  #WebSocketImpl
  #log
  #socket = null
  #hello = null
  #handshake = null
  #connecting = null
  #pending = new Map()
  #seq = 0
  #events = []
  #maxEvents = 200
  /** 我想订阅的种类（跨连接累积：插件只说一次"我要 chat/death/…"）。 */
  #wanted = new Set()
  /** **这条连接上**已经订阅成功的种类。连接级状态，重连后必须清空（见 #resetConnectionState）。 */
  #subscribed = new Set()
  #listeners = new Set()
  #lastError = null
  #disposed = false

  /**
   * @param {object} options
   * @param {string} options.url
   * @param {string} [options.token]              单个 token（兼容）
   * @param {Array<{token:string,path?:string}>} [options.tokenCandidates]
   *        多个候选（推荐）：连接时逐个试，被 1008 拒就换下一个。
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.WebSocketImpl]    注入点（测试用）
   * @param {Function} [options.log]
   */
  constructor ({ url, token, tokenCandidates, timeoutMs = 20_000, WebSocketImpl, log } = {}) {
    this.#url = url
    this.#timeoutMs = timeoutMs
    this.#WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket
    this.#log = typeof log === 'function' ? log : () => {}
    if (typeof this.#WebSocketImpl !== 'function') {
      throw new SiriusError('当前运行环境没有 WebSocket（需要 Node ≥ 22）')
    }
    const list = Array.isArray(tokenCandidates) ? tokenCandidates.filter((c) => c && typeof c.token === 'string' && c.token.trim()) : []
    this.#candidates = list.length > 0
      ? list.map((c) => ({ token: c.token.trim(), path: c.path ?? '(token)' }))
      : (typeof token === 'string' && token.trim() ? [{ token: token.trim(), path: '(token)' }] : [])
  }

  configure ({ url, tokenCandidates = [] }) {
    if (this.#socket || this.#connecting) throw new SiriusError('重置连接后才能更换 game_dir 和 token 来源')
    const list = Array.isArray(tokenCandidates) ? tokenCandidates.filter((c) => c && typeof c.token === 'string' && c.token.trim()) : []
    this.#url = url
    this.#candidates = list.map((c) => ({ token: c.token.trim(), path: c.path ?? '(token)' }))
    this.#resetConnectionState()
  }

  get url () { return this.#url }
  get online () { return Boolean(isOpen(this.#socket) && this.#hello?.ok === true) }
  get protocol () { return this.#hello?.protocol_version }
  get lastError () { return this.#lastError }
  /** token 来源清单（诊断用；只暴露路径，不暴露 token 本身）。 */
  get tokenSources () { return this.#candidates.map((c) => c.path) }

  /** 建立连接并完成 token 握手；并发调用合并到同一次握手。 */
  async connect ({ timeoutMs = this.#timeoutMs } = {}) {
    if (this.online) return this.#hello
    if (this.#connecting) return this.#connecting
    this.#connecting = this.#openSocket(timeoutMs).finally(() => { this.#connecting = null })
    return this.#connecting
  }

  /**
   * 逐个候选 token 尝试握手。
   * 只有 close 1008（bridge 的策略层拒绝 = token 不匹配）才换下一个；
   * 其它错误（超时/连接失败）直接抛——换 token 也救不了。
   */
  async #openSocket (timeoutMs) {
    if (this.#candidates.length === 0) {
      throw new SiriusError(
        '没有可用的 sirius-bridge token：插件没有找到任何 config/sirius_bridge.toml。'
        + '请确认游戏已启动到标题屏，并在插件配置里给 gameDir / tokenPath / token 之一'
        + '（或把游戏实例目录填进 discoverDirs）。',
        { hint: 'sirius_status 会显示 tokenSources（为空即表示一个来源都没找到）' },
      )
    }
    let lastError = null
    for (let index = 0; index < this.#candidates.length; index += 1) {
      const candidate = this.#candidates[index]
      try {
        const ack = await this.#openWithToken(candidate, timeoutMs)
        if (index > 0) this.#log(`握手改用 token 来源：${candidate.path}`)
        else this.#log(`握手使用 token 来源：${candidate.path}`)
        return ack
      } catch (error) {
        lastError = error
        this.#teardown(null)
        if (error?.code !== CLOSE_POLICY) throw error
        this.#log(`token 被 bridge 拒绝（${candidate.path}），尝试下一个来源`)
      }
    }
    const sources = this.#candidates.map((c) => c.path).join(' | ')
    throw new SiriusError(
      `所有候选 token 都被 bridge 拒绝（close 1008）：${sources}。`
      + `请确认下面这个文件属于正在监听 ${this.#url} 的那个游戏实例。`,
      { code: CLOSE_POLICY, hint: '通常是启动器"版本隔离"导致每个实例各有一份 token' },
    )
  }

  #openWithToken (candidate, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        settle(reject, new SiriusError(
          `连接 ${this.#url} 超时（${timeoutMs}ms）。确认游戏已启动、bridge 已在 127.0.0.1 监听。`,
          { hint: 'sirius_status 会显示 online:false' },
        ))
        this.#teardown('handshake timeout')
      }, timeoutMs)

      let ws
      try {
        ws = new this.#WebSocketImpl(this.#url)
      } catch (error) {
        settle(reject, new SiriusError(`无法创建到 ${this.#url} 的连接：${error?.message ?? error}`))
        return
      }
      this.#socket = ws
      this.#hello = null
      this.#handshake = {
        resolve: (ack) => settle(resolve, ack),
        reject: (error) => settle(reject, error),
      }

      ws.addEventListener('open', () => {
        if (this.#socket !== ws) return
        try {
          ws.send(JSON.stringify({ type: 'hello', token: candidate.token, protocol_version: HELLO_PROTOCOL }))
        } catch (error) {
          this.#handshake?.reject(new SiriusError(`握手帧发送失败：${error?.message ?? error}`))
          this.#teardown('hello send failed')
        }
      })
      ws.addEventListener('message', (event) => {
        if (this.#socket === ws) this.#handleFrame(event?.data)
      })
      ws.addEventListener('close', (event) => {
        if (this.#socket !== ws) return
        const code = event?.code
        const reason = event?.reason ? `：${event.reason}` : ''
        const rejected = code === CLOSE_POLICY
        const error = new SiriusError(
          rejected
            ? `bridge 拒绝了握手（close 1008${reason}）—— 这个 token 不对（来源 ${candidate.path}）。`
            : `bridge 连接关闭（code ${code}${reason}）`,
          { code },
        )
        this.#lastError = error.message
        this.#handshake?.reject(error)
        this.#failPending(error)
        this.#socket = null
        this.#hello = null
        this.#resetConnectionState()
      })
      ws.addEventListener('error', () => {
        if (this.#socket !== ws) return
        this.#lastError = 'bridge 连接出错'
        this.#handshake?.reject(new SiriusError('bridge 连接出错（详情见 close 帧）'))
      })
    })
  }

  #handleFrame (raw) {
    const frame = parseFrame(raw)
    if (!frame) return
    switch (frame.type) {
      case 'hello_ack': {
        this.#hello = frame
        if (frame.ok !== true) {
          this.#handshake?.reject(new SiriusError('bridge 握手失败（hello_ack.ok=false）'))
          this.#teardown('hello_ack not ok')
          return
        }
        this.#log(`bridge 已连接 ${this.#url}（协议 ${frame.protocol_version}）`)
        // 🔴 订阅与事件缓冲都是**连接级**的：新连接上 bridge 侧一条订阅都没有，
        //   notification 的 seq 也从 0 重新开始。跨连接保留旧集合会让 subscribe()
        //   误判"已经订过了"而一句都不发 —— 2026-11-01 真机证据：重启客户端后那条
        //   连接 2269 个请求里 `events.subscribe` 一次都没有，于是喊不应、
        //   watchdog.received 冻住不动。所以每成功握手一次就重置，并自动重订。
        this.#resetConnectionState()
        this.#handshake?.resolve(frame)
        this.#handshake = null
        this.#resubscribe()
        return
      }
      case 'notification': {
        const record = {
          event: frame.event,
          data: frame.data ?? {},
          timestamp: frame.timestamp,
          seq: frame.seq,
          receivedAt: Date.now(),
        }
        this.#events.push(record)
        if (this.#events.length > this.#maxEvents) {
          this.#events.splice(0, this.#events.length - this.#maxEvents)
        }
        for (const listener of this.#listeners) {
          try { listener(record) } catch { /* 监听器自己的错不该打断分发 */ }
        }
        return
      }
      case 'response': {
        const entry = this.#pending.get(frame.id)
        if (!entry) return
        this.#pending.delete(frame.id)
        clearTimeout(entry.timer)
        if (frame.error) {
          entry.reject(new SiriusError(
            frame.error.message ?? `bridge 返回错误 ${frame.error.code}`,
            { code: frame.error.code, method: entry.method, data: frame.error.data },
          ))
        } else {
          entry.resolve(frame.result)
        }
        return
      }
      default:
        return
    }
  }

  /**
   * 发一个 RPC。`signal` 取消只放弃等待（游戏侧动作不会因此停止），
   * 这符合 bridge 的现实：没有 cancel 帧，动作层原语自己是短跑。
   */
  async call (method, params = {}, { timeoutMs = this.#timeoutMs, signal } = {}) {
    if (this.#disposed) throw new SiriusError('插件已卸载', { method })
    await this.connect({ timeoutMs: Math.min(timeoutMs, this.#timeoutMs) })
    if (signal?.aborted) throw new SiriusError('调用已取消', { method })

    const id = `sfw-${++this.#seq}`
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new SiriusError(`调用 ${method} 已取消（等待被放弃；游戏侧动作可能仍在进行）`, { method }))
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new SiriusError(`调用 ${method} 超时（${timeoutMs}ms）`, {
          method,
          hint: '游戏窗口最小化时渲染线程不收任务，工具会超时；把窗口恢复即可。',
        }))
      }, timeoutMs)
      const entry = { resolve, reject, timer, method }
      this.#pending.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#socket.send(JSON.stringify({ type: 'request', id, method, params }))
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new SiriusError(`发送 ${method} 失败：${error?.message ?? error}`, { method }))
      }
    })
  }

  /**
   * 订阅事件（可多次调用，按并集累积）。
   * `#wanted` 记住"想要什么"（跨连接），`#subscribed` 只记"这条连接上已经订到什么" ——
   * 两者分开是 2026-11-01 那次的教训：只看集合大小会以为重连后仍然订着。
   */
  async subscribe (types = EVENT_KINDS) {
    for (const type of types) this.#wanted.add(type)
    const covered = [...this.#wanted].every((type) => this.#subscribed.has(type))
    if (covered) return { subscribed: true, types: [...this.#subscribed] }
    const result = await this.call('events.subscribe', { types: [...this.#wanted], min_level: null }, { timeoutMs: 8_000 })
    this.#subscribed = new Set(this.#wanted)
    return result
  }

  /** 这条连接上已经订阅成功的种类（诊断用）。 */
  get subscribed () { return [...this.#subscribed] }

  /** 新连接上把"想订阅的集合"重发一次；失败只记日志，下次工具调用还会再试。 */
  #resubscribe () {
    if (this.#disposed || this.#wanted.size === 0) return
    this.subscribe([...this.#wanted]).catch((error) => {
      this.#log(`重订事件失败：${error?.message ?? error}`)
    })
  }

  /** 丢掉"属于上一条连接"的状态：订阅集合 + 事件缓冲（seq 按连接计数，旧值会让 since 过滤全空）。 */
  #resetConnectionState () {
    this.#subscribed = new Set()
    this.#events = []
  }

  /** 读事件缓冲（内存 ring，200 条）。`since` 是 seq（不含）。 */
  events ({ since = -1, types, limit = 30 } = {}) {
    const filter = types?.length ? new Set(types) : null
    const rows = this.#events.filter((e) => (filter ? filter.has(e.event) : true))
      .filter((e) => typeof e.seq !== 'number' || e.seq > since)
    return rows.slice(-Math.max(1, limit))
  }

  onEvent (listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * 连接态 + **就绪判据**。
   * 🔴 真机教训（2026-10-30）：`getStats.in_game=true` 时 GUI 可能还是
   * `ReceivingLevelScreen`（区块没收完），此时任何动作都会撞在加载屏上。
   * 所以 `ready` 必须是「在游戏里 且 没有 GUI」。
   */
  async status ({ timeoutMs = 8_000 } = {}) {
    const base = {
      online: this.online,
      url: this.#url,
      protocol: this.protocol ?? null,
      inGame: false,
      screen: null,
      ready: false,
      lastError: this.#lastError,
      pendingEvents: this.#events.length,
      tokenSources: this.tokenSources,
    }
    // 探活：没连上就先尝试连一次（`sirius_status` 的意义就在这里）。
    // 连不上不抛——把原因放进 lastError 让模型/用户看。
    if (!this.online) {
      try {
        await this.connect({ timeoutMs: Math.min(timeoutMs, 4_000) })
      } catch (error) {
        return { ...base, lastError: error?.message ?? String(error) }
      }
    }
    if (!this.online) return { ...base, lastError: this.#lastError }
    let stats
    let gui
    try {
      [stats, gui] = await Promise.all([
        this.call('getStats', {}, { timeoutMs }),
        this.call('getGuiState', {}, { timeoutMs }),
      ])
    } catch (error) {
      return { ...base, online: this.online, lastError: error?.message ?? String(error) }
    }
    const inGame = stats?.in_game === true
    const screen = gui?.screen_open === true ? (gui.screen_class ?? 'unknown') : null
    return {
      ...base,
      online: true,
      protocol: this.protocol ?? null,
      inGame,
      screen,
      ready: inGame && screen === null,
      gameMode: stats?.game_mode ?? null,
      position: stats?.position ?? null,
      health: stats?.health ?? null,
      food: stats?.food ?? null,
      // 1.6 增补：窗口焦点影响原版悬停和拖拽；另外返回时间、天气和群系。
      // 老 jar 没有这些字段 → undefined，调用方要按"未知"处理，不要当成 false。
      windowFocused: typeof stats?.window_focused === 'boolean' ? stats.window_focused : null,
      dayTime: Number.isFinite(stats?.day_time) ? stats.day_time : null,
      day: Number.isFinite(stats?.day) ? stats.day : null,
      isDay: typeof stats?.is_day === 'boolean' ? stats.is_day : null,
      raining: typeof stats?.raining === 'boolean' ? stats.raining : null,
      thundering: typeof stats?.thundering === 'boolean' ? stats.thundering : null,
      biome: typeof stats?.biome === 'string' ? stats.biome : null,
    }
  }

  #failPending (error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  #teardown (why) {
    try { this.#socket?.close() } catch { /* ignore */ }
    this.#socket = null
    this.#hello = null
    this.#resetConnectionState()
    if (why) this.#log(`bridge 断开：${why}`)
  }

  async reset (reason = 'sirius_init') {
    this.#failPending(new SiriusError(`bridge 连接已由 ${reason} 重置`))
    this.#teardown(reason)
    const connecting = this.#connecting
    if (connecting) {
      try { await connecting } catch { /* 重置就是放弃旧握手 */ }
      this.#teardown(reason)
    }
    this.#lastError = null
  }

  close () {
    this.#disposed = true
    this.#failPending(new SiriusError('插件已卸载'))
    this.#teardown('dispose')
    this.#listeners.clear()
  }
}
