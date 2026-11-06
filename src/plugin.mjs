/**
 * Host 插件入口：连接管理（进程级单例）+ 工具注册 + 提示词节 + 按 preset 划可见性
 * + 看门狗（游戏事件 → 叫醒模型）。
 * ============================================================================
 * 可见性策略（2026-10-31 用户定）：
 *   · **Sirius 主会话**：默认放行全部已注册工具，只禁用 bash / pwsh / plugin_manager；
 *     skill、Web、文件与协作工具可用。子代理仍使用独立白名单。
 *   · **其它会话**：隐藏 sirius_*，只留只读的 sirius_status 当自检入口。
 * ============================================================================
 */
import { BridgeLink, EVENT_KINDS } from './bridge.mjs'
import { bridgeConnectionForGameDir, candidateTokenPaths, findBridgeTokenCandidates, normalizeConfig } from './config.mjs'
import { noticeMessage } from './message.mjs'
import { section as promptSection } from './prompt.mjs'
import { createPersonaLoader } from './persona.mjs'
import { createChatTail, formatChatTail, formatRecentChat } from './chattail.mjs'
import { fileURLToPath } from 'node:url'
import { createTools, TOOL_NAMES } from './tools.mjs'
import { Watchdog } from './watchdog.mjs'
import { Autonomy } from './autonomy.mjs'
import { Observer } from './observer.mjs'
import { Proximity, horizontalDistance, isSelfEntity } from './proximity.mjs'
import { BodyOwnership } from './ownership.mjs'
import { createBridgeMaintenanceTick } from './maintenance.mjs'
import { ScriptRuntime } from './script/runtime.mjs'
import { PluginRegistry } from './plugin/registry.mjs'
import { ActionScheduler } from './plugin/scheduler.mjs'
import { SessionPluginManager } from './plugin/session-manager.mjs'
import { registerOfficialSkill, registerPluginDevelopmentSkill } from './skill.mjs'

export const inject = ['tools', 'systemPrompt', 'agents', 'skills']

const PRESET_MATCH = 'sirius'

/**
 * Sirius **子代理**（主代理派出去的跑腿）能用什么：**只有腿和眼睛，没有嘴。**
 * 设计依据（2026-10-31 裁决）：身体只有一个客户端，两个 agent 同时说话会抢人设、
 * 同时抢 GUI 会互相打脸。所以子代理：
 *   · 有：感知（status/context/inventory/players/world/gui/screenshot/events/look）
 *        + 动作（walk/stop/dig/place/use）
 *   · 没有：`sirius_say`（不许自己跟玩家说话，结果回传主代理转述）
 *   · 有但收紧：`sirius_command` —— 工具内再过滤，只放行 `#stop`/`#pause`/`#resume`
 *   · 没有：subagent/send_message/interrupt_agent（不许无限套娃）
 */
export const SUB_TOOLS = [
  'sirius_status', 'sirius_context', 'sirius_inventory', 'sirius_players', 'sirius_world',
  'sirius_gui', 'sirius_screenshot', 'sirius_events', 'sirius_script', 'sirius_plugin', 'sirius_look',
  'sirius_walk', 'sirius_tunnel', 'sirius_stop', 'sirius_follow', 'sirius_dig', 'sirius_place', 'sirius_use',
  'sirius_command',
  'todo_write', 'read_image',
]

/**
 * Sirius 主会话默认放行，只禁用本机执行和插件管理。skill、Web、Soul、文件和
 * 协作工具不再需要逐项加白名单。子代理仍使用 SUB_TOOLS 白名单。
 * 本 profile 的文件策略是 danger-full-access（无沙箱），行为约束由提示词承担。
 */
export const SIRIUS_DENY = [
  'bash', 'pwsh', 'plugin_manager',
]

export function apply (ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (message) => {
    try { ctx.logger?.info?.(`[sirius-for-whale] ${message}`) } catch { /* 日志不该影响加载 */ }
  }

  // ---------------------------------------------------------------- 连接
  const candidates = findBridgeTokenCandidates(config)
  if (candidates.length === 0) {
    const tried = candidateTokenPaths(config)
    log('一个 sirius-bridge token 都没找到——工具会明确报"没有可用的 token"')
    log(`已找过：${tried.length ? tried.join(' | ') : '（没有候选路径：请配置 gameDir / tokenPath / discoverDirs）'}`)
  } else {
    for (const candidate of candidates) {
      log(`token 候选：${candidate.path}${candidate.port ? `（port ${candidate.port}）` : ''}`)
    }
  }
  const port = candidates.find((candidate) => candidate.port)?.port
  const url = port ? `ws://127.0.0.1:${port}` : config.url
  const link = new BridgeLink({ url, tokenCandidates: candidates, timeoutMs: config.timeoutMs, log })
  ctx.effect(() => () => link.close(), 'sirius-for-whale: close bridge')

  // ---------------------------------------------------------------- 看门狗
  // 放在工具注册**之前**：工具层要把"我刚说过话"喂给它（回声抑制）。
  const siriusAgents = new Set()
  /** Sirius 会话派出去的**子代理**（工具面被裁剪成"腿和眼睛"）。 */
  const siriusSubAgents = new Set()
  const ownership = new BodyOwnership()

  /**
   * 距离快照：把"谁在跟我说话"补上"离我多远"。
   * 数据源 `world.query{entities}`（真机确认 players 在里面）+ `getStats` 自己的位置；
   * 3 秒缓存，一次查询服务多条聊天。**看不见的玩家给 'unknown'，不猜数字。**
   */
  const proximity = new Proximity({
    query: (range) => link.call('world.query', { type: 'entities', range }, { timeoutMs: 6_000 })
      .then((result) => result?.entities ?? []),
    stats: () => link.status({ timeoutMs: 6_000 }),
    // 🔴 "附近有人"说的**不是她自己**：world.query 的玩家列表里包含她本人，
    //    不剔掉的话每次自主提醒都会说"附近有 Sirius（就贴着你）"（用户2026-10-31 报）。
    self: () => ({ uuid: watchdog.selfUuid, name: watchdog.selfName }),
    log,
    config: config.proximity ?? {},
  })

  /** 自己是不是这个实体（observer 的"有人走近"也要用同一条判据）。 */
  const selfFilter = (entity, origin) => isSelfEntity(entity, origin, {
    uuid: watchdog.selfUuid,
    name: watchdog.selfName,
  })

  /** 近聊游标（下面 `createChatTail` 赋值）。声明在这里是为了让 `deliverWake` 能引用它。 */
  let chatTail = null

  /** 〔近期聊天〕：**任何**唤醒都带上（用户2026-10-31）。正文里已有的那句不再重复。 */
  const recentChat = (avoid = '') => {
    try {
      return formatRecentChat(link.events({ types: ['chat'], limit: 40 }) ?? [], {
        max: config.chatTail?.recentMax ?? 6,
        avoid,
      })
    } catch {
      return null
    }
  }

  const deliverWake = (text) => {
    const owner = ownership.owner
    const target = [...siriusAgents].find((agent) => String(agent?.id ?? '') === owner)
    if (!target) {
      log('看门狗命中，但当前没有持有身体的 sirius 会话；等待某会话收到人类消息后再投递')
      return
    }
    const block = recentChat(text)
    const body = block ? `${text}\n\n${block}` : text
    if (block) {
      try { chatTail?.markDelivered?.() } catch { /* 没有游标就不标 */ }
    }
    try {
      target.steer(noticeMessage(body))
      log(`看门狗唤醒身体所有者 ${String(target.id ?? '?')}：${text.split('\n')[1] ?? ''}`)
    } catch (error) {
      log(`唤醒 ${String(target.id ?? '?')} 失败：${error?.message ?? error}`)
    }
  }

  /**
   * 循环观察：**时间和聊天内容共同决定"要不要看一眼"**。
   * 一眼 = 一次便宜的结构化感知（getStats + 附近实体），不是截图；
   * 只有"值得说"的变化（有人走近/很饿/附近多了敌对生物）才汇报并叫醒模型。
   */
  const observer = new Observer({
    log,
    config: config.observer ?? {},
    sense: async () => {
      const status = await link.status({ timeoutMs: 6_000 })
      if (status?.online !== true || status?.inGame !== true) return null
      const me = status.position
      let entities = []
      try {
        const result = await link.call('world.query', { type: 'entities', range: 24 }, { timeoutMs: 6_000 })
        entities = result?.entities ?? []
      } catch { /* 拿不到实体就只报血量/饱食 */ }
      const players = []
      let hostiles = 0
      for (const entity of entities) {
        const type = String(entity?.type ?? '')
        if (type === 'minecraft:player') {
          // 她自己也在玩家列表里：不剔掉就会一直报"有人走近（Sirius）"
          if (selfFilter(entity, me)) continue
          players.push({ name: entity.name ?? entity.uuid ?? '?', distance: horizontalDistance(entity.position, me) })
        } else if (/(zombie|creeper|skeleton|spider|enderman|slime|witch|pillager|husk|drowned|blaze|ghast|warden|phantom)/i.test(type)) {
          hostiles += 1
        }
      }
      return { health: status.health, food: status.food, position: me, players, hostiles }
    },
    report: deliverWake,
  })
  ctx.effect(() => () => observer.dispose?.(), 'sirius-for-whale: observer')

  /**
   * 近聊游标：动作类工具返回时顺手贴"干活期间的新聊天"（只给增量，见 src/chattail.mjs）。
   * 看门狗唤醒时会把已贴过的行标成"已给过"，避免同一句话出现两遍。
   */
  chatTail = createChatTail({
    fetchRows: () => link.events({ types: ['chat'], limit: 40 }),
    selfName: () => watchdog.selfName ?? null,
    max: config.chatTail?.max ?? 3,
  })

  const watchdog = new Watchdog({
    deliver: (text) => {
      // 看门狗已经把这几条聊天贴给模型了 → 记下来，别再当"近聊"重贴一次
      try { chatTail.markDelivered() } catch { /* ignore */ }
      deliverWake(text)
    },
    log,
    config: {
      ...(config.watchdog ?? {}),
      wakeOn: { ...(config.watchdog?.wakeOn ?? {}), damage: false },
      // 同步读快照：聊天事件里不能等一次网络往返，晚 3 秒的距离对判断没影响
      distanceOf: ({ uuid }) => {
        if (!uuid) return null
        const hit = proximity.lookup(uuid)
        return hit.band === 'unknown' ? null : hit
      },
      // 命中即通知观察循环：有人跟我说话 → 接下来一段时间看勤一点
      onMatch: (hit) => observer.noteChat({ tier: hit.tier }),
    },
  })
  ctx.effect(() => () => watchdog.dispose(), 'sirius-for-whale: watchdog')
  // 自主节律：没人跟它说话时，它自己想起来做点事（同一个投递通道，同样走 steer）。
  const autonomy = new Autonomy({ deliver: deliverWake, log, config: config.autonomy ?? {} })
  ctx.effect(() => () => autonomy.dispose(), 'sirius-for-whale: autonomy')
  const offEvents = link.onEvent((record) => {
    // 聊天到了就顺手刷一次距离快照（3 秒 TTL 内会合并）：本条用上一份，
    // 下一条就准了——比让唤醒等一次网络往返划算得多。
    if (record?.event === 'chat' && record.data?.system !== true) {
      proximity.refresh().catch(() => {})
    }
    watchdog.onEvent(record)
  })
  ctx.effect(() => () => offEvents(), 'sirius-for-whale: bridge event feed')
  /** 订阅状态：工具层的 diagnostics 要读它（只能通过闭包，工具定义时订阅可能还没成）。 */
  const bridgeState = { subscribed: false }

  /**
   * 与工具层共享的跨重连状态（见 tools.mjs 的 createTools(state)）：
   * - `capabilities`：对端 bridge 的协议版本与是否支持 `use`（老 jar 要降级，不能静默失败）；
   * - `baritone`：已下发的 Baritone 策略缓存。客户端重启/重连后游戏里的设置可能已回到默认，
   *   所以断线时整份清空，下次走路会重新发 `#setting`。
   */
  const bridgeCache = {
    capabilities: { protocol: null, hasUse: null },
    baritone: { allowBreak: null, allowPlace: null, chatControl: null },
    /** 可见性策略的实际执行结果（哪些全局工具真放行了、哪些名字不是全局被跳过）。 */
    policy: null,
    screenshot: config.screenshot ?? {},
    workspaceDir: (exec) => {
      const service = ctx.get('workingDirectory')
      if (!exec?.agent?.session || typeof service?.get !== 'function') return null
      return service.get(exec.agent.session)
    },
    /** 后台走路任务的通知通道（= 唤醒/插话同一条 steer），由 createTools 用它构造 WalkTracker。 */
    notify: deliverWake,
    /** 子代理 id 集合（工具层据此收紧 say/command）：同一份引用，增删即时可见。 */
    subagentIds: siriusSubAgents,
    canControl: (agentId) => {
      const id = String(agentId ?? '')
      const known = [...siriusAgents, ...siriusSubAgents].some((agent) => String(agent?.id ?? '') === id)
      return known ? ownership.canControl(id) : null
    },
  }

  const scripts = new ScriptRuntime({
    link,
    canControl: bridgeCache.canControl,
    canSpeak: (owner) => String(owner) === ownership.owner,
    onSelfSpoke: (text) => watchdog.noteSelfSpoke(text),
    log,
    config: config.scripts ?? {},
  })
  bridgeCache.scripts = scripts
  const scheduler = new ActionScheduler()
  scheduler.bindRuntime(scripts)
  scripts.scheduler = scheduler
  const plugins = new SessionPluginManager({
    registry: new PluginRegistry({ storageFile: config.plugins?.storageFile ?? '' }),
    runtime: scripts,
    scheduler,
    notify: deliverWake,
    log,
    runStateFile: config.plugins?.runStateFile ?? '',
    ownerRoot: (owner) => ownership.rootOf(owner) ?? owner,
    damageWatch: {
      ...(config.watchdog ?? {}),
      enabled: config.watchdog?.wakeOn?.damage !== false,
    },
    workspace: (owner) => {
      const root = ownership.rootOf(owner) ?? owner
      const agent = [...siriusAgents, ...siriusSubAgents].find((candidate) => String(candidate?.id ?? '') === root)
      const service = ctx.get('workingDirectory')
      return agent?.session && typeof service?.get === 'function' ? service.get(agent.session) : null
    },
  })
  bridgeCache.plugins = plugins
  ctx.effect(() => () => plugins.dispose(), 'sirius-for-whale: plugin manager')
  ctx.effect(() => () => scripts.dispose(), 'sirius-for-whale: script runtime')

  // ---------------------------------------------------------------- 工具
  // 🔴 逐个注册 + 单独兜错：某个工具的 schema 不合法时，绝不能把 apply 整体打断
  //    （2026-10-31：screenshot 的 minimum/maximum 抛错，导致其后 7 个工具全丢）。
  const tools = createTools({
    ctx,
    link,
    log,
    state: bridgeCache,
    onSelfSpoke: (text) => watchdog.noteSelfSpoke(text),
    diagnostics: () => ({
      watchdog: watchdog.stats,
      autonomy: autonomy.stats,
      observer: observer.stats,
      scripts: scripts.snapshot(),
      plugins: plugins.snapshot(),
      proximity: proximity.stats,
      walk: bridgeCache.walk?.snapshot?.() ?? null,
      follow: bridgeCache.follow?.snapshot?.() ?? null,
      selfIdentity: watchdog.needsSelf() ? 'stale' : 'fresh',
      tools: bridgeCache.policy,
      ownership: ownership.snapshot(),
      subscribed: bridgeState.subscribed,
      // 这条连接**实际**订阅到了哪些事件（`watchdog.received` 冻住时先看这个：
      // 空数组 = 收不到 chat 通知 = 喊不应，2026-11-01 事故的判据）
      subscribedTypes: link.subscribed,
      protocol: bridgeCache.capabilities.protocol,
      has_use: bridgeCache.capabilities.hasUse,
    }),
  })
  let registered = 0
  for (const tool of tools) {
    try {
      const dispose = ctx.tools.register(tool)
      ctx.effect(() => () => dispose(), `sirius-for-whale: tool ${tool.name}`)
      registered += 1
    } catch (error) {
      log(`注册 ${tool.name} 失败（其它工具不受影响）：${String(error?.message ?? error).slice(0, 240)}`)
    }
  }
  log(`已注册 ${registered}/${tools.length} 个工具（目标 ${url}）`)
  registerOfficialSkill(ctx)
  registerPluginDevelopmentSkill(ctx)
  plugins.restore({ owner: ownership.owner ?? '' })
    .catch((error) => log(`恢复启用插件失败：${error?.message ?? error}`))

  // ---------------------------------------------------------------- 提示词
  if (typeof ctx.systemPrompt?.section === 'function') {
    // ① 人设：从 `persona.txt` 读（按 mtime 热加载），不写在 YAML 里
    const defaultPersonaFile = fileURLToPath(new URL('../persona.txt', import.meta.url))
    const loadPersona = createPersonaLoader({
      file: config.personaFile || defaultPersonaFile,
      inline: config.persona,
      log,
    })
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'sirius-persona',
      order: 10,
      text: () => loadPersona().text,
    }), 'sirius-for-whale: persona section')
    log(`人设来源：${loadPersona().source}`)

    // ② 行为规则：`text` 是函数，每次装配都重新读一遍真实能力（协议版本/后台走路/子代理数），
    // 所以"提示里说了什么"永远等于"这台身体现在真能做什么"。
    ctx.effect(() => ctx.systemPrompt.section(promptSection(() => ({
      protocol: bridgeCache.capabilities.protocol,
      hasUse: bridgeCache.capabilities.hasUse,
      walkActive: bridgeCache.walk?.active === true,
      subagents: siriusSubAgents.size,
    }))), 'sirius-for-whale: prompt section')
  } else {
    log('宿主没有 systemPrompt.section，跳过提示词注入')
  }

  // ---------------------------------------------------------------- 订阅与身份
  let subscribed = false
  let subscribing = false

  /**
   * 刷新"我是谁"。看门狗靠它排除自己的发言。
   * 🔴 必须定期重取：单机离线 uuid ≠ 服务器正版 uuid，重连也会变
   *    （2026-10-31 真机：进服务器后 00000000-… → 11111111-…，一次性缓存导致过滤失效）。
   */
  const refreshSelf = () => {
    if (!watchdog.needsSelf()) return
    link.call('players', {}, { timeoutMs: 6_000 })
      .then((result) => {
        const me = (result?.players ?? []).find((player) => player.self)
        if (me?.uuid) {
          watchdog.setSelf(me.uuid, me.name)
          log(`看门狗身份：${me.name ?? me.uuid}`)
        }
      })
      .catch(() => { /* 不在服里就算了，下个周期再试 */ })
  }

  const ensureSubscribed = () => {
    if (subscribed || subscribing) return
    subscribing = true
    link.subscribe(EVENT_KINDS)
      .then(() => {
        subscribed = true
        bridgeState.subscribed = true
        log(`已订阅游戏事件：${EVENT_KINDS.join('/')}`)
        refreshSelf()
      })
      .catch(() => { /* 游戏没开就算，下个周期再试 */ })
      .finally(() => { subscribing = false })
  }
  ensureSubscribed()

  /**
   * 探测对端能力（协议版本 + 是否认 `use`）。只在未知或断线后重新探测。
   * `capabilities/list` 从协议 1.0 起就有，所以这里失败基本等于"没连上"——留给下个周期。
   */
  const probeCapabilities = () => {
    if (bridgeCache.capabilities.protocol !== null) return
    link.call('capabilities/list', {}, { timeoutMs: 6_000 })
      .then((result) => {
        const entries = Array.isArray(result) ? result : (result?.capabilities ?? result?.result ?? [])
        const names = new Set((entries ?? []).map((entry) => entry?.name).filter(Boolean))
        const protocol = Array.isArray(result) ? null : (result?.protocol_version ?? null)
        bridgeCache.capabilities.protocol = protocol ?? 'unknown'
        bridgeCache.capabilities.hasUse = names.has('use')
        log(`对端 bridge：协议 ${protocol ?? '?'}，工具 ${names.size} 个${names.has('use') ? '（含 use）' : '（无 use → 门兜底关闭）'}`)
      })
      .catch(() => { /* 没连上 / 老 jar：下个周期再来 */ })
  }
  probeCapabilities()

  /**
   * 自主节律的事实采集：只在**真要开口**时才去问（每次 2 个 RPC），
   * 平时只用 `link.status()` 的 online/inGame 做便宜的前置判断。
   */
  const tickAutonomy = async () => {
    if (!ownership.owner) return
    let status
    try {
      status = await link.status({ timeoutMs: 6_000 })
    } catch {
      return
    }
    if (!autonomy.shouldFire({ online: status?.online === true, inGame: status?.inGame === true })) return
    const facts = {
      online: true,
      inGame: true,
      health: status.health ?? null,
      food: status.food ?? null,
      maxHealth: 20,
      position: status.position ?? null,
      players: [],
      recentEvents: [],
      selfName: watchdog.selfName ?? null,
    }
    try {
      const roster = await link.call('players', {}, { timeoutMs: 6_000 })
      facts.players = roster?.players ?? []
    } catch { /* 名单拿不到就按"只有自己"算 */ }
    try {
      const rows = link.events({ limit: 3 }) ?? []
      facts.recentEvents = rows.map((row) => `${row.event}${row.data?.message ? `: ${String(row.data.message).slice(0, 40)}` : ''}`)
    } catch { /* 事件环取不到就不带 */ }
    // 附近有谁、多远（自主时间最需要这条：有人就在旁边 vs 只是在线）
    try {
      await proximity.refresh()
      facts.nearbyPlayers = proximity.describeNearby()
    } catch { /* 拿不到就不带 */ }
    autonomy.fire(facts)
  }

  const maintenanceTick = createBridgeMaintenanceTick({
    link,
    bridgeCache,
    getSubscribed: () => subscribed,
    setSubscribed: (value) => {
      subscribed = value
      bridgeState.subscribed = value
    },
    ensureSubscribed,
    probeCapabilities,
    refreshSelf,
    tickAutonomy,
    log,
  })
  let maintenanceRunning = false
  const ticker = setInterval(() => {
    if (maintenanceRunning) return
    maintenanceRunning = true
    maintenanceTick()
      .catch((error) => log(`周期维护失败：${error?.message ?? error}`))
      .finally(() => { maintenanceRunning = false })
  }, 20_000)

  // 观察循环的节律比 20s 细（刚有人说话时 5s 一眼），单独一个便宜的心跳：
  // 每次只是判断"到点没"，真感知只在 due 时才发 RPC。
  const watchTick = setInterval(() => {
    observer.tick().catch(() => { /* 观察失败不影响任何主链 */ })
  }, 5_000)
  watchTick.unref?.()
  ctx.effect(() => () => clearInterval(watchTick), 'sirius-for-whale: observe ticker')

  // 后台 walk/follow 推进：只有任务存在时才花状态往返（2s 一次）。
  const walkTick = setInterval(() => {
    if (bridgeCache.walk?.active) bridgeCache.walk.tick().catch(() => { /* 走路跟踪失败不影响主链 */ })
    if (bridgeCache.follow?.active) bridgeCache.follow.tick().catch(() => { /* 跟随跟踪失败不影响主链 */ })
  }, 2_000)
  walkTick.unref?.()
  ctx.effect(() => () => clearInterval(walkTick), 'sirius-for-whale: walk ticker')
  ticker.unref?.()
  ctx.effect(() => () => clearInterval(ticker), 'sirius-for-whale: subscribe/identity ticker')

  bridgeCache.init = async (exec, args = {}) => {
    const agentId = String(exec?.agent?.id ?? '')
    const agent = [...siriusAgents].find((candidate) => String(candidate?.id ?? '') === agentId)
    if (!agent) throw new Error('只有已挂载的 Sirius 主会话可以调用 sirius_init')
    let connectionOverride = null
    const requestedGameDir = String(args.game_dir ?? '').trim()
    if (requestedGameDir) {
      connectionOverride = bridgeConnectionForGameDir(requestedGameDir, config.url)
    }
    const workspaceConfig = await plugins.prepare({ owner: agentId })
    const previousOwner = ownership.owner
    const owner = ownership.activate(agentId)
    if (owner !== agentId) throw new Error('无法把身体控制权绑定到当前 Sirius 会话')
    autonomy.noteHumanActivity()
    await scripts.retireAll('sirius_init')
    try { await bridgeCache.stopBody?.() } catch { /* 离线时停止命令发不出去，仍继续重置连接 */ }
    await link.reset('sirius_init')
    if (connectionOverride) link.configure(connectionOverride)
    subscribed = false
    bridgeState.subscribed = false
    bridgeCache.capabilities.protocol = null
    bridgeCache.capabilities.hasUse = null
    bridgeCache.baritone.allowBreak = null
    bridgeCache.baritone.allowPlace = null
    bridgeCache.baritone.chatControl = null
    chatTail.reset()
    await link.connect()
    await link.subscribe(EVENT_KINDS)
    subscribed = true
    bridgeState.subscribed = true
    await plugins.restore({ owner })
    refreshSelf()
    probeCapabilities()
    log(`身体控制权：${previousOwner ?? '（无）'} → ${owner}；桥连接已由 sirius_init 重置`)
    return {
      result: 'initialized',
      owner,
      previous_owner: previousOwner,
      protocol: link.protocol ?? null,
      subscribed: true,
      game_dir: connectionOverride?.gameDir ?? null,
      workspace: plugins.activationInfo?.() ?? workspaceConfig,
    }
  }

  // ---------------------------------------------------------------- 可见性
  const releases = new Map()

  const composedPreset = (agent) => {
    try {
      return ctx.get('agentPresets')?.composedPreset?.(agent.ctx)
    } catch {
      return undefined
    }
  }
  const isSiriusPreset = (preset) => typeof preset === 'string'
    && preset.toLowerCase().includes(PRESET_MATCH)

  /** `restrict({allow})` 对宿主不认识的名字会抛；从报错里读回"它认识的名字"再试一次。 */
  const restrictAllow = (scoped, names) => {
    try {
      return scoped.restrict({ allow: names })
    } catch (error) {
      const knownPart = /known global tools:\s*([\s\S]*)$/.exec(String(error?.message ?? error))
      const known = new Set((knownPart?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      const usable = names.filter((name) => known.has(name))
      if (known.size > 0 && usable.length > 0) {
        log(`白名单里有宿主不认识的名字（${names.filter((n) => !known.has(n)).join(', ')}）→ 已按实际存在的工具过滤`)
        return scoped.restrict({ allow: usable })
      }
      throw error
    }
  }

  /**
   * 黑白名单里**真的是全局工具**的那些名字。`restrict` 遇到 scope-local 或未注册
   * 名字会整次抛错，所以先过滤；结果同时进入 `sirius_status.diagnostics.tools`。
   */
  const existingGlobals = (names) => names.filter((name) => {
    try { return ctx.tools?.get?.(name) !== undefined } catch { return false }
  })

  /** 这个 agent 是不是某个 Sirius 会话派出来的子代理（不看 preset，看归属关系）。 */
  const siriusParentOf = (agent) => {
    if (!agent?.id) return null
    for (const parent of siriusAgents) {
      if (!parent || parent === agent) continue
      try {
        if (ctx.agents?.isOwnedBy?.(agent.id, parent) === true) return parent
      } catch { /* 服务不可用时按"不是子代理"处理 */ }
    }
    return null
  }

  const applyPolicy = (agent) => {
    if (!agent) return
    // ① 先判"是不是 Sirius 子代理"：它的 preset 往往不可读，但归属关系是确定的
    const parent = siriusParentOf(agent)
    const preset = composedPreset(agent)
    if (!parent && (preset === undefined || preset === null)) {
      log(`agent ${String(agent.id ?? '?')} 的 preset 暂不可读，暂不限制`)
      return
    }
    const previous = releases.get(agent)
    if (previous) {
      try { previous() } catch { /* 旧手柄失效无所谓 */ }
      releases.delete(agent)
    }
    const scoped = agent.ctx.get('tools')
    if (!scoped?.restrict) {
      log('拿不到 scoped tools，跳过可见性限制')
      return
    }
    try {
      if (parent) {
        // 子代理：只给腿和眼睛（说不说话、发不发命令都由主代理兜着）
        const release = restrictAllow(scoped, SUB_TOOLS)
        releases.set(agent, release)
        siriusSubAgents.add(agent)
        ownership.attach(agent.id, parent.id)
        agent.ctx.effect(() => () => {
          const current = releases.get(agent)
          if (current) {
            try { current() } catch { /* ignore */ }
            releases.delete(agent)
          }
        }, 'sirius-for-whale: release sub policy')
        log(`子代理 ${String(agent.id ?? '?')}（派自 ${String(parent.id ?? '?')}）：放行 ${SUB_TOOLS.length} 个工具（无 say / 命令受限）`)
        return
      }
      const sirius = isSiriusPreset(preset)
      let release
      if (sirius) {
        const denied = existingGlobals(SIRIUS_DENY)
        const dropped = SIRIUS_DENY.filter((name) => !denied.includes(name))
        bridgeCache.policy = { mode: 'deny', requested: SIRIUS_DENY.length, denied, dropped }
        if (dropped.length > 0) {
          log(`黑名单里 ${dropped.length} 个不是当前已注册的全局工具，已跳过：${dropped.join(', ')}`)
        }
        release = scoped.restrict({ deny: denied })
      } else {
        release = scoped.restrict({ deny: TOOL_NAMES.filter((name) => name !== 'sirius_status') })
      }
      releases.set(agent, release)
      agent.ctx.effect(() => () => {
        const current = releases.get(agent)
        if (current) {
          try { current() } catch { /* ignore */ }
          releases.delete(agent)
        }
      }, 'sirius-for-whale: release policy')
      if (sirius) {
        siriusAgents.add(agent)
        ownership.attach(agent.id)
        ensureSubscribed()
        log(`preset=${preset}：主会话默认放行，禁用 ${bridgeCache.policy?.denied?.join('/') ?? '（无）'}；子代理仍按白名单限制`)
      } else {
        siriusAgents.delete(agent)
        ownership.remove(agent.id)
        log(`preset=${preset}：隐藏 sirius_*（保留 sirius_status）`)
      }
    } catch (error) {
      log(`应用可见性规则失败（preset=${preset}）：${String(error?.message ?? error).slice(0, 200)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => applyPolicy(agent))

  // ---------------------------------------------------------------- 近聊尾巴
  /**
   * 动作类工具返回时，把"你干活期间新出现的聊天"贴到结果末尾（只给增量）。
   * 放在 post-execute 而不是每个工具里改：一处生效、口径统一、以后加工具不用再动。
   *
   * 三条纪律：
   *   · 只给 Sirius 会话（主代理 + 子代理）的调用；
   *   · 只给动作类工具（`sirius_status`/`inventory` 这种查了又查的不贴）；
   *   · 结构化结果（`decision.value`）不碰——只往 content 里追加一块文本。
   */
  const CHAT_TAIL_TOOLS = new Set([
    'sirius_walk', 'sirius_tunnel', 'sirius_stop', 'sirius_follow', 'sirius_dig', 'sirius_place', 'sirius_use',
    'sirius_command', 'sirius_say', 'sirius_key', 'sirius_type', 'sirius_click',
    'sirius_look', 'sirius_screenshot',
  ])
  if (config.chatTail?.enabled !== false) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'accept' || decision.value !== undefined) return decision
        if (!CHAT_TAIL_TOOLS.has(String(exec?.name ?? ''))) return decision
        const callerId = exec?.agent?.id
        const known = [...siriusAgents, ...siriusSubAgents].some((agent) => agent?.id === callerId)
        if (!known) return decision
        const text = formatChatTail(chatTail.take())
        if (!text) return decision
        const content = Array.isArray(decision.content) ? decision.content : (result?.content ?? [])
        return { ...decision, content: [...content, { type: 'text', text }] }
      } catch {
        return decision
      }
    })
  }
  ctx.on('agent/disposed', ({ agent }) => {
    const wasOwner = String(agent?.id ?? '') === ownership.owner
    siriusAgents.delete(agent)
    siriusSubAgents.delete(agent)
    ownership.remove(agent?.id)
    releases.delete(agent)
    if (wasOwner) {
      scripts.retireAll('agent_disposed').catch(() => {})
      bridgeCache.stopBody?.().catch?.(() => {})
    }
  })
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (!siriusAgents.has(agent) || !ownership.canControl(agent?.id)) return
    // 宿主给的 idle/running：自主节律靠它量"真空闲多久"和"这一轮花了多久"
    autonomy.noteStatus(status)
  })
  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
    if (!siriusAgents.has(agent) || !ownership.canControl(agent?.id)) return
    // 自己投的 notice（plugin:*) 不算"人类在说话"，否则会把自主的空闲计时反复清零
    const kind = String(message?.source?.kind ?? '')
    if (kind.startsWith('plugin:')) return
    autonomy.noteHumanActivity()
  })
  ctx.on('agent-preset/selected', (sessionId) => {
    try {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent) applyPolicy(agent)
    } catch (error) {
      log(`preset 变化后重划线失败：${String(error?.message ?? error).slice(0, 160)}`)
    }
  })

  try {
    const live = ctx.agents?.list?.() ?? []
    for (const agent of live) applyPolicy(agent)
    if (live.length) log(`已对 ${live.length} 个现存会话应用可见性规则`)
  } catch (error) {
    log(`遍历现存会话失败：${String(error?.message ?? error).slice(0, 160)}`)
  }
}
