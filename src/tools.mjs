/**
 * 工具面（30 个）。原则：**薄翻译**——参数与 verdict 词表跟 bridge 协议一一对应，
 * 不在这一层加工语义；语义判断留给模型（它读到 result 再决定下一步）。
 *
 * 每个工具统一返回 `{ summary, data?, image? }`：
 *   · summary 是给模型看的一行结论（`render` 优先用它）；
 *   · data 是原始结构化结果（需要时模型自己读）；
 *   · image 是图片附件（预留给需要附件的工具；screenshot 只返回工作区路径）。
 * ============================================================================
 */

const GLFW = { T: 84, ENTER: 257, ESC: 256 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

import { randomUUID } from 'node:crypto'
import { supportsGuiClick } from './plugin/input.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WalkTracker } from './walk.mjs'
import { walkGoal, walkArrived, walkDistance } from './walk-goal.mjs'
import { FollowTracker } from './follow.mjs'
import { toLosslessJSON } from './json.mjs'

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`)

function short (value, max = 60) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return truncate(String(text ?? ''), max)
}

/** 输出契约：宽松对象（结果形状由 bridge 决定，插件不二次建模）。 */
const OUTPUT = { schema: { type: 'object', additionalProperties: true } }

function renderSummary (value) {
  const blocks = []
  if (value?.summary) blocks.push({ type: 'text', text: String(value.summary) })
  if (value?.data !== undefined) {
    blocks.push({ type: 'text', text: truncate(JSON.stringify(value.data, null, 1), 6000) })
  }
  if (value?.image?.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '（无结果）' })
  return blocks
}

/**
 * 宿主 `assertSupportedJsonSchema` 只接受这些关键字（见 dsh-tools/lib/types/json-schema.js）：
 * type/oneOf/properties/required/additionalProperties/items/enum/const + 四个注解键。
 * `minimum`/`maximum`/`minLength`/`pattern` 之类**不属于支持子集**，注册时会抛错。
 * 🔴 2026-10-31 真机事故：screenshot 的 quality 带了 minimum/maximum → register 抛错 →
 *    apply 整体中断 → 它之后的 7 个工具全没注册（表现为"只有 sirius_status"）。
 *    所以这里在**定义期**就断言，范围一律写进 description。
 */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

export function assertSupportedParameters (node, path = 'parameters') {
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      throw new Error(
        `${path}.${key} 不在宿主支持的 JSON Schema 子集里（只允许 ${[...ALLOWED_SCHEMA_KEYS].join('/')}）；`
        + '范围/长度这类约束请写进 description',
      )
    }
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        assertSupportedParameters(child, `${path}.properties.${name}`)
      }
    } else if (key === 'items') {
      assertSupportedParameters(value, `${path}.items`)
    } else if (key === 'oneOf' && Array.isArray(value)) {
      value.forEach((child, index) => assertSupportedParameters(child, `${path}.oneOf[${index}]`))
    }
  }
}

function defineTool ({ name, description, parameters, timeoutMs, run }) {
  assertSupportedParameters(parameters, `${name}.parameters`)
  return {
    name,
    description,
    parameters,
    ...(timeoutMs ? { timeoutMs } : {}),
    output: { schema: OUTPUT.schema, render: (_args, value) => renderSummary(value) },
    async execute (args, exec) {
      const value = await run(args ?? {}, exec)
      // 🔴 宿主把工具返回值当 JsonValue 校验：出现 undefined / NaN / Infinity / bigint /
      //    函数 / 环就报 `invalid output: value is not lossless JSON`——**而动作其实已经
      //    执行完了**（2026-11-01 用户报"命令说失败但实际成功了"）。
      //    所以统一在出口压一遍无损 JSON；`image` 是附件句柄，原样透传不动它。
      if (value === null || typeof value !== 'object') return toLosslessJSON(value)
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (key === 'image') { out[key] = item; continue }
        const next = toLosslessJSON(item)
        if (next !== undefined) out[key] = next // undefined 的键**删掉**，别留成 undefined
      }
      return out
    },
  }
}

const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra })
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })

/** 未连接时统一给一句"怎么修"，别让模型对着 ECONNREFUSED 猜。 */
function offlineHint (error) {
  return `${error?.message ?? error}\n提示：sirius_status 可看连接态；token 从游戏实例的 config/sirius_bridge.toml 自动发现。`
}

/**
 * @param {object} options
 * @param {object} [options.state] 与 plugin.mjs 共享的可变状态（跨工具 / 跨重连生效）：
 *   `capabilities` = 对端 bridge 的能力探测结果（`protocol` / `hasUse`），
 *   `baritone`     = 已下发的 Baritone 策略缓存（重连后由 plugin 置 null 以强制重发）。
 *   不传（单测）时这里自建一份，行为一致。
 */
export function createTools ({ ctx, link, log, onSelfSpoke, diagnostics, state }) {
  const sharedState = state ?? {
    capabilities: { protocol: null, hasUse: null },
    baritone: { allowBreak: null, allowPlace: null, chatControl: null },
  }
  sharedState.capabilities ??= { protocol: null, hasUse: null }
  sharedState.baritone ??= { allowBreak: null, allowPlace: null, chatControl: null }
  sharedState.baritone.chatControl ??= null


  const safeStatus = async (timeoutMs = 8_000) => {
    try {
      return await link.status({ timeoutMs })
    } catch {
      return { online: false, ready: false, inGame: false, screen: null }
    }
  }

  const requireReady = async (what) => {
    const status = await safeStatus()
    if (!status.online) {
      throw new Error(offlineHint(new Error('未连接到 sirius-bridge')))
    }
    if (!status.inGame) {
      throw new Error(`现在不在游戏里（${what}需要先进世界）`)
    }
    if (!status.ready) {
      throw new Error(`游戏界面正开着（${status.screen}），${what}前请先关掉界面或等加载完成`)
    }
    return status
  }

  /**
   * 只要求"在游戏里"——键鼠工具天然工作在**界面开着**的时候
   * （E 打开背包、在背包里点槽位、往搜索框打字），所以不能用 requireReady。
   */
  const requireInGame = async (what) => {
    const status = await safeStatus()
    if (!status.online) throw new Error(offlineHint(new Error('未连接到 sirius-bridge')))
    if (!status.inGame) throw new Error(`现在不在游戏里（${what}需要先进世界）`)
    return status
  }

  /**
   * 1.6 才有的方法：老 jar 上调用会回 `-32601`。
   * 与其让模型读一句 JSON-RPC 错误，不如在工具层直接教它"去升级 jar"。
   * 协议还没探测到（null）时放行——让桥自己报错，别在客户端瞎拦。
   */
  const hasProtocol16 = () => {
    const raw = sharedState.capabilities?.protocol
    if (!raw || raw === 'unknown') return true
    const [major, minor] = String(raw).split('.').map((part) => Number(part))
    return Number.isFinite(major) && (major > 1 || (major === 1 && minor >= 6))
  }

  const requireProtocol16 = (what) => {
    if (hasProtocol16()) return
    throw new Error(`桥的协议是 ${sharedState.capabilities.protocol}，${what}需要 1.6：先升级客户端 mods 里的 sirius_bridge jar`)
  }

  const hasProtocol17 = () => {
    const raw = sharedState.capabilities?.protocol
    if (!raw || raw === 'unknown') return true
    const [major, minor] = String(raw).split('.').map((part) => Number(part))
    return Number.isFinite(major) && (major > 1 || (major === 1 && minor >= 7))
  }

  const requireProtocol17 = (what) => {
    if (hasProtocol17()) return
    throw new Error(`桥的协议是 ${sharedState.capabilities.protocol}，${what}需要 1.7：先升级客户端 mods 里的 sirius_bridge jar`)
  }

  const hasProtocol19 = () => {
    const raw = sharedState.capabilities?.protocol
    if (!raw || raw === 'unknown') return true
    const [major, minor] = String(raw).split('.').map((part) => Number(part))
    return Number.isFinite(major) && (major > 1 || (major === 1 && minor >= 9))
  }

  const requireProtocol19 = (what) => {
    if (hasProtocol19()) return
    throw new Error(`桥的协议是 ${sharedState.capabilities.protocol}，${what}需要 1.9：先升级客户端 mods 里的 sirius_bridge jar`)
  }

  // ---------------------------------------------------------------- 状态与感知

  const init = defineTool({
    name: 'sirius_init',
    description:
      '让当前 Sirius 会话独占这台游戏身体，重置桥连接，并初始化/挂载本会话工作区的 scripts、config 和 state。'
      + '可传 game_dir 指定 Minecraft 实例目录，DSH 从该目录的 config/sirius_bridge.toml 自动读取 token 和端口，无需提供 token。'
      + '其它会话不会再收到游戏唤醒或执行动作；旧会话之后也可再次调用它来接管，保留各自聊天历史、配置和游戏世界进度。子代理不能调用。',
    parameters: obj({
      game_dir: str('可选：Minecraft 实例目录；只用于定位 config/sirius_bridge.toml，不改变公开配置'),
    }),
    timeoutMs: 30_000,
    run: async (args, exec) => {
      if (callerIsSubagent(exec)) throw new Error('子代理不能初始化身体：请由它的 Sirius 主会话调用 sirius_init')
      if (typeof sharedState.init !== 'function') throw new Error('当前宿主没有配置 sirius_init')
      const data = await sharedState.init(exec, args)
      return {
        summary: `本会话已取得身体独占控制权，桥连接已重置（owner=${data?.owner ?? '?'}）。游戏世界和会话历史未重置。`,
        data,
      }
    },
  })

  const status = defineTool({
    name: 'sirius_status',
    description:
      '身体状态：是否连上 bridge、是否在游戏里、当前开着的界面、是否就绪（在游戏里且没开界面）、血量/饱食/坐标/模式。'
      + '做任何动作前先看它就绪没有；ready=false 时动作会被加载屏或 GUI 吞掉。',
    parameters: obj(),
    run: async (args, exec) => {
      const value = await link.status()
      const bits = [
        value.online ? `已连接 ${value.url}（协议 ${value.protocol ?? '?'}）` : `未连接（${value.lastError ?? '未建立连接'}）`,
        value.inGame ? '在游戏内' : '不在游戏内',
        value.screen ? `界面=${value.screen}` : '无界面',
        value.ready ? 'READY' : 'NOT-READY',
      ]
      if (value.inGame) {
        bits.push(`HP ${value.health ?? '?'} 食 ${value.food ?? '?'} @ ${short(value.position, 50)} (${value.gameMode ?? '?'})`)
        if (value.windowFocused === false) bits.push('窗口未激活（原版悬停与拖拽受焦点影响）')
        else if (value.windowFocused === true) bits.push('窗口在前台')
      }
      const diag = diagnostics?.()
      // 喊不应最快的判据：事件订阅丢了 → 永远收不到 chat 通知（2026-11-01 那次就是它，
      // 而且当时 `watchdog.received` 冻在 3 上，光看诊断数字看不出来）
      if (value.online) {
        const subs = Array.isArray(diag?.subscribedTypes) ? diag.subscribedTypes : null
        if (subs && subs.length === 0) {
          bits.push('⚠ 事件订阅为空：听不到聊天/喊你（重连一下或重启 DSH）')
        }
      }
      const canControl = typeof sharedState.canControl === 'function'
        ? sharedState.canControl(exec?.agent?.id)
        : null
      if (canControl === true) bits.push('本会话持有身体')
      if (canControl === false) bits.push('本会话未持有身体（只读；调用 sirius_init 接管）')
      const ongoing = walkTracker.snapshot?.() ?? null
      if (ongoing) {
        bits.push(`正在后台走：目标 (${ongoing.target.x}, ${ongoing.target.z})，还有 ${ongoing.distance != null ? ongoing.distance.toFixed(1) : '?'} 格，已 ${Math.round(ongoing.elapsed_ms / 1000)}s`)
      }
      const body = { owner: diag?.ownership?.owner ?? null, can_control: canControl }
      const data = diag ? { ...value, ongoing, body, diagnostics: diag } : { ...value, ongoing, body }
      return { summary: bits.join(' · '), data }
    },
  })

  const context = defineTool({
    name: 'sirius_context',
    description:
      '玩家 + 环境快照：血量/吸收/饱食/饱和/氧气/经验/维度/坐标/朝向/模式/药水/骑乘，'
      + '以及**时间（第几天、白天黑夜）、天气、群系、窗口焦点**——这些以前只能靠截图猜。',
    parameters: obj(),
    run: async () => {
      const data = await link.call('getStats', {})
      if (data?.in_game !== true) return { summary: '不在游戏内（标题屏或正在断开）', data }
      const pos = data.position ?? {}
      const clock = Number.isFinite(data.day_time)
        ? `第${data.day ?? '?'}天 ${String(Math.floor(data.day_time / 1000)).padStart(2, '0')}:${String(Math.floor((data.day_time % 1000) / 1000 * 60)).padStart(2, '0')}${data.is_day === false ? '（夜）' : data.is_day === true ? '（昼）' : ''}`
        : null
      const weather = data.thundering === true ? '雷雨' : data.raining === true ? '下雨' : data.raining === false ? '晴' : null
      const env = [clock, weather, data.biome].filter(Boolean).join(' · ')
      return {
        summary: `HP ${data.health}/${data.air ?? '-'} 食 ${data.food} 坐标 (${short([pos.x, pos.y, pos.z].map((n) => Math.round(n * 10) / 10).join(', '), 40)}) `
          + `${data.dimension} ${data.game_mode} yaw=${Math.round(data.yaw ?? 0)}° pitch=${Math.round(data.pitch ?? 0)}°`
          + `${env ? ` · ${env}` : ''}`,
        data,
      }
    },
  })

  const inventory = defineTool({
    name: 'sirius_inventory',
    description:
      '读背包（不用开界面）：41 个容器槽 0-8 快捷栏 / 9-35 主背包 / 36-39 盔甲 / 40 副手，含数量、空槽、选中格。'
      + 'filter 用物品 registry 名（oak_log 会自动补 minecraft:）或 #tag。',
    parameters: obj({
      filter: { type: 'array', items: { type: 'string' }, description: '只看这些物品（1..16 条，registry 名或 #tag）' },
      scope: { type: 'string', enum: ['all', 'hotbar', 'main', 'armor', 'offhand'], description: '只读某个区段，默认 all' },
    }),
    run: async (args) => {
      const params = {}
      if (args.filter?.length) params.filter = args.filter
      if (args.scope) params.scope = args.scope
      const data = await link.call('inventory', params)
      if (data?.in_game !== true) return { summary: '不在游戏内', data }
      const slots = (data.slots ?? []).filter((s) => s.item)
      // 模组物品的 registry id（create:cogwheel）对模型没意义，显示名（齿轮）才认得出；
      // 两个都给，但纯原版那种 id 与名字只差大小写/下划线的就不重复列（噪音）。
      const head = slots.slice(0, 12).map((s) => `${withDisplay(s.item, s.display)}×${s.count}@${s.slot}(${s.role})`).join(', ')
      return {
        summary: `选中槽 ${data.selected}；非空 ${slots.length} 个：${head || '（空）'}`
          + (slots.length > 12 ? ` …共 ${slots.length}` : ''),
        data,
      }
    },
  })

  const players = defineTool({
    name: 'sirius_players',
    description: '在线玩家名单（含自己）：名字、uuid、延迟、游戏模式。聊天里的 sender uuid 靠它对上名字。',
    parameters: obj(),
    run: async () => {
      const data = await link.call('players', {})
      if (data?.in_game !== true) return { summary: '不在服务器里', data }
      const who = (data.players ?? []).map((p) => `${p.name}${p.self ? '(我)' : ''}${p.gamemode ? `/${p.gamemode}` : ''}`)
      return { summary: `${data.count} 人在线：${who.join(', ') || '（无）'}`, data }
    },
  })

  const world = defineTool({
    name: 'sirius_world',
    description:
      '查世界：blocks 返回方块坐标与注册名（filter 支持 registry 名与 #tag，命中按距离升序、最多 32 条）；'
      + 'entities 返回实体（含掉落物的 item/count、怪物的 category）。半径上限 64。',
    parameters: obj({
      query: { type: 'string', enum: ['blocks', 'entities'], description: 'blocks 或 entities' },
      range: num('半径（格）。blocks 默认 4，entities 默认 16；上限 64'),
      filter: { type: 'array', items: { type: 'string' }, description: '只看这些方块/实体（registry 名或 #tag；entities 不支持 #tag）' },
      aggregate: bool('只回按类型的计数（"半径 20 内各种石头各多少"），不回逐条坐标——省 token'),
      cursor: int('分页游标：从命中序列第几条开始（0 起，默认 0）。翻页用上一轮返回的 next_cursor'),
      limit: int('本次最多几条（1..512，默认 128）'),
    }, ['query']),
    params: null,
    run: async (args) => {
      const params = { type: args.query, range: args.range ?? (args.query === 'blocks' ? 4 : 16) }
      if (args.filter?.length) params.filter = args.filter
      if (args.aggregate === true) params.aggregate = true
      if (args.cursor != null) params.cursor = args.cursor
      if (args.limit != null) params.limit = args.limit
      const data = await link.call('world.query', params, { timeoutMs: 25_000 })
      if (data?.in_game === false) return { summary: '不在游戏内', data }

      const more = data?.has_more === true ? `（还有更多，next_cursor=${data.next_cursor}）` : ''
      // 聚合模式：不逐条列坐标，只给"哪几种、各多少"——这是省 token 的关键
      if (args.aggregate === true) {
        const counts = (data.counts ?? []).slice(0, 12)
          .map((row) => `${row.name}×${row.count}`)
        return {
          summary: `${args.query === 'blocks' ? '方块' : '实体'}类型 ${data.counts?.length ?? 0} 种，共 ${data.count ?? 0} 个：`
            + `${counts.join('、') || '（无）'}`,
          data,
        }
      }
      // 逐条模式：摘要给 15 行（原来是 10，一整片区域常常不够看），完整数据在 data 里
      if (args.query === 'blocks') {
        const rows = (data.blocks ?? []).slice(0, 15)
          .map((b) => `${b.block}@${b.x},${b.y},${b.z}`)
        return {
          summary: `方块 ${data.count ?? rows.length} 个${data.truncated ? '（已截断）' : ''}${more}：${rows.join('; ') || '（无）'}`,
          data,
        }
      }
      const rows = (data.entities ?? []).slice(0, 15)
        .map((e) => `${e.type}${e.item ? `(${e.item}×${e.count ?? 1})` : ''}@${short(e.position, 30)}${e.health != null ? ` hp${e.health}` : ''}`)
      return {
        summary: `实体 ${data.count ?? rows.length} 个${data.truncated ? '（已截断）' : ''}${more}：${rows.join('; ') || '（无）'}`,
        data,
      }
    },
  })

  const gui = defineTool({
    name: 'sirius_gui',
    description:
      '当前界面结构快照：屏幕类名、widget（按钮/输入框/文本，含坐标与文案）、容器槽（含物品与角色）。'
      + '比截图更适合精确点击；没有界面时 screen_open=false。',
    parameters: obj(),
    run: async () => {
      const data = await link.call('getGuiState', {})
      if (data?.screen_open !== true) return { summary: '当前没有打开任何界面', data }
      const widgets = (data.widgets ?? []).length
      const slots = (data.slots ?? []).length
      return {
        summary: `界面 ${data.screen_class}：widget ${widgets} 个、容器槽 ${slots} 个${
          data.fallback ? '（降级为矩形模式）' : ''}`,
        data,
      }
    },
  })

  const screenshot = defineTool({
    name: 'sirius_screenshot',
    description:
      '把当前游戏画面（含 HUD 与打开的界面）保存到当前工作区的 images/ 文件夹，并返回图片路径。'
      + 'tier=crop 时给 bbox 裁剪。这个工具只保存文件，不直接附图；需要看图时把返回路径交给官方 read_image。',
    parameters: obj({
      tier: { type: 'string', enum: ['full', 'crop'], description: 'full 全屏（默认）；crop 需同时给 bbox' },
      bbox: { type: 'array', items: { type: 'number' }, description: 'crop 的裁剪框 [x,y,w,h]（像素，左上原点）' },
      quality: int('JPEG 质量 0-100（默认 80）'),
    }),
    timeoutMs: 40_000,
    run: async (args, exec) => {
      const params = { tier: args.tier ?? 'full' }
      if (args.bbox) params.bbox = args.bbox
      if (args.quality != null) params.quality = args.quality
      const data = await link.call('screenshot', params, { timeoutMs: 30_000 })
      const base64 = data?.image_b64 ?? ''
      if (!base64) throw new Error('bridge 没有返回图片数据')
      if (typeof sharedState.workspaceDir !== 'function') {
        throw new Error('无法确定当前会话工作区，截图未保存')
      }
      const workspace = await sharedState.workspaceDir(exec)
      if (!workspace) throw new Error('无法确定当前会话工作区，截图未保存')
      const format = String(data?.format ?? 'jpeg').toLowerCase()
      const extension = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg'
      const filename = `sirius-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`
      const relativePath = `images/${filename}`
      const filePath = join(workspace, relativePath)
      const bytes = Buffer.from(base64, 'base64')
      await mkdir(join(workspace, 'images'), { recursive: true })
      await writeFile(filePath, bytes, { flag: 'wx' })
      const { image_b64: _omit, ...rest } = data ?? {}
      return {
        summary: `截图 ${data?.width ?? '?'}×${data?.height ?? '?'} ${data?.format ?? ''} q=${data?.quality ?? '?'}`
          + `${data?.downscaled ? '（已降采样）' : ''}；已保存 ${relativePath}；用 read_image 读取`,
        data: {
          ...rest,
          bytes: bytes.length,
          path: filePath,
          relative_path: relativePath,
        },
      }
    },
  })

  // ---------------------------------------------------------------- 说话与命令

  const say = defineTool({
    name: 'sirius_say',
    description: '在公屏说话（进程内直发，死亡屏等 GUI 也发得出去）。只想说话时用它；**它不会执行 /命令**。',
    parameters: obj({ text: str('要说的话，1..256 字符') }, ['text']),
    run: async (args, exec) => {
      // 子代理没有说话权：同一个身体里两个声音会抢人设（工具白名单已挡，这里再兜一层）
      if (callerIsSubagent(exec)) {
        throw new Error('子代理没有说话权：把要转述的内容回传主代理，由它来跟玩家说')
      }
      // `chat.send` 是**界面免疫**的（死亡屏、睡觉时的 InBedChatScreen 都发得出去），
      // 所以这里只要"在游戏里"。🔴 2026-10-31 真机（用户报）：躺在床上发不出消息——
      // 因为当时用的是 requireReady，而 InBedChatScreen 让 ready=false，直接被自己挡住。
      await requireInGame('说话')
      const data = await link.call('chat.send', { string: args.text })
      // 记下自己刚说过的话：5 秒内同文本的 chat 事件按回声处理，不再叫醒自己。
      try { onSelfSpoke?.(args.text) } catch { /* 诊断回调不该影响说话 */ }
      return { summary: `已发送：${short(args.text, 80)}`, data }
    },
  })

  const horizontal = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : 0)


  /**
   * `registry:id` + 游戏内显示名，一起给模型看。
   * 差值判据：把 id 最后一段和显示名都去掉大小写/空格/下划线后比较——
   * `minecraft:oak_log` 与 "Oak Log" 视为同一个（只列 id，省噪音）；
   * `create:cogwheel` 与 "齿轮" 不同 → 列成 `create:cogwheel（齿轮）`。
   * 自定义命名（铁砧改名）也走这条，会显示成 `minecraft:iron_sword（我的剑）`。
   */
  const withDisplay = (id, display) => {
    const raw = String(id ?? '')
    if (!display) return raw
    const norm = (text) => String(text ?? '').replace(/[\s_]/g, '').toLowerCase()
    const tail = norm(raw.split(':').pop())
    const name = norm(display)
    return tail === name ? raw : `${raw}（${display}）`
  }

  /**
   * 调用者是不是 Sirius 子代理（由 plugin 维护的集合，同一份引用）。
   * 用于工具层的兜底收紧：say 一律拒、command 只放 #stop/#pause/#resume。
   */
  const callerIsSubagent = (exec) => {
    const id = exec?.agent?.id
    const ids = sharedState.subagentIds
    return Boolean(id && ids && typeof ids.has === 'function' && ids.has(id))
  }

  /**
   * 发一条命令。**按前缀分两条通道**（2026-10-31 真机取证）：
   *
   * - `#` 开头（Baritone 客户端指令）→ `chat.send`，进程内直发，**不开任何界面**。
   *   原理：Baritone 的 `MixinClientPlayNetHandler` 注入在
   *   `ClientPacketListener.sendChat(String)` 的 HEAD，命中 `#` 前缀就 `ci.cancel()`
   *   交给命令系统；而 `chat.send` 调的正是同一个方法（ChatTools.java:81）。
   *   实测：`chat.send("#goto 57 90 -771")` → 聊天框出现
   *   `[Baritone] Going to: GoalBlock{x=57,y=90,z=-771}`，15s 走了 9.85 格，
   *   服务器零泄漏；而且界面免疫（不用先 ESC）、不抢键盘、不吃 T 键。
   * - `/` 开头（服务器命令）→ 仍走真实聊天栏（T → 文本 → ENTER）：
   *   `sendChat` 不会执行 `/`（那是聊天栏对自己的特判），`/give` 会被当普通聊天发出。
   */
  const sendCommand = async (text, { waitMs = 700 } = {}) => {
    if (text.startsWith('#')) {
      await link.call('chat.send', { string: text })
      // Baritone 的拦截发生在 sendChat 的 HEAD（同步 cancel），留一帧给它起手。
      await sleep(Math.min(waitMs, 120))
      return { closed: true, channel: 'chat.send' }
    }
    let gui = await link.call('getGuiState', {})
    if (gui?.screen_open === true) {
      await link.call('input.key', { code: GLFW.ESC })
      await sleep(320)
      gui = await link.call('getGuiState', {})
      if (gui?.screen_open === true) {
        throw new Error(`界面 ${gui.screen_class} 关不掉，先手动关一下再发命令`)
      }
    }
    await link.call('input.key', { code: GLFW.T })
    await sleep(420)
    const opened = await link.call('getGuiState', {})
    if (opened?.screen_open !== true) {
      await sleep(300)
      const retry = await link.call('getGuiState', {})
      if (retry?.screen_open !== true) throw new Error('聊天栏没有打开（T 键注入未生效）')
    }
    await link.call('input.text', { string: text })
    await sleep(240)
    await link.call('input.key', { code: GLFW.ENTER })
    await sleep(waitMs)
    const after = await link.call('getGuiState', {})
    // `channel` 一定要给值：留成 undefined 会被宿主判成"非无损 JSON"
    // （2026-11-01：`/` 命令就是这样报"执行失败"的，其实已经发出去了）
    return { closed: after?.screen_open !== true, channel: 'chatbar' }
  }

  const command = defineTool({
    name: 'sirius_command',
    description:
      '发一条命令（服务器命令或客户端模组命令，如 /give、/gamemode、Baritone 的 #goto）。'
      + '**按前缀分两条通道**：`#` 开头（Baritone 客户端指令）进程内直发、不开界面、界面免疫；'
      + '`/` 开头（服务器命令）必须走真实聊天栏（T → 文本 → ENTER），因为 chat.send 不执行 /。'
      + '**带 verify**：发完等 300ms 回读聊天与界面，给出三值结论——'
      + 'confirmed（看到新聊天/界面变化，有证据）/ sent（发出去了但服务端没回音，别因此重发）/ '
      + 'unknown（连发没发出去都不确定，比如聊天栏被挡住）。',
    parameters: obj({ text: str('完整命令文本（含开头的 / 或 #），1..256 字符') }, ['text']),
    timeoutMs: 30_000,
    run: async (args, exec) => {
      // 子代理的命令权限收窄到"只会喊停"：它没有上下文判断该不该动别人的脚
      if (callerIsSubagent(exec) && !/^#(stop|pause|resume)\b/i.test(String(args.text ?? '').trim())) {
        throw new Error('子代理只能用 sirius_command 发 #stop / #pause / #resume；其它命令（含 / 开头）请回传主代理执行')
      }
      // `#` 走 chat.send（界面免疫）只要"在游戏里"；`/` 要开聊天栏，仍然要求没有界面挡着
      const viaChat = String(args.text ?? '').trimStart().startsWith('#')
      const status = viaChat ? await requireInGame('发命令') : await requireReady('发命令')

      // verify 的取证基线：聊天事件游标 + 界面类名
      const seqBefore = (link.events({ limit: 1 })[0]?.seq) ?? 0
      const guiBefore = await link.call('getGuiState', {}).catch(() => null)
      const { closed, channel } = await sendCommand(args.text)
      // 300ms：够一个服务端回执的往返，又不至于把工具拖慢
      await sleep(300)
      const fresh = link.events({ types: ['chat'], since: seqBefore, limit: 8 })
        .map((row) => String(row.data?.message ?? '')).filter(Boolean)
      const guiAfter = await link.call('getGuiState', {}).catch(() => null)
      const screenChanged = (guiBefore?.screen_class ?? null) !== (guiAfter?.screen_class ?? null)
      const confirmed = fresh.length > 0 || screenChanged
      const delivered = channel === 'chat.send' || closed === true
      const verdict = confirmed ? 'confirmed' : (delivered ? 'sent' : 'unknown')

      const where = channel === 'chat.send' ? '进程内直发（未开界面）' : `聊天栏${closed ? '已关闭' : '仍开着（可能没发出去）'}`
      const evidence = confirmed
        ? `；回执：${(fresh.length ? fresh : [`界面→${guiAfter?.screen_class ?? '未知'}`]).map((line) => short(line, 60)).join(' | ')}`
        : '；服务端没有回音（/give 这类静默命令正常）'
      return {
        summary: `已发送命令：${short(args.text, 80)}；${where} → ${verdict}${evidence}`
          + `（就绪态: ${status.ready ? 'ready' : 'not-ready'}）`,
        data: {
          sent: args.text,
          closed,
          channel,
          verify: verdict,
          evidence: { chat: fresh, screen_before: guiBefore?.screen_class ?? null, screen_after: guiAfter?.screen_class ?? null },
        },
      }
    },
  })

  // ---------------------------------------------------------------- 键鼠（bridge input.*）
  // 这是"手"：GUI 交互（开背包、点槽位、拖物品、输入告示牌）全靠这三个。
  // 特殊键的 GLFW 码；**字母/数字/功能键按规则生成**（GLFW: A-Z=65-90、0-9=48-57、F1-F12=290-301），
  // 否则模型按一个没列进表的键就会被拒（真机就踩过：想按 Y 报"不认识的键名"）。
  const KEY_CODES = {
    ESC: 256, ENTER: 257, TAB: 258, SPACE: 32, BACKSPACE: 259, DELETE: 261,
    SHIFT: 340, LSHIFT: 340, RSHIFT: 344, CTRL: 341, LCTRL: 341, ALT: 342, SUPER: 343,
    UP: 265, DOWN: 264, LEFT: 263, RIGHT: 262,
    HOME: 268, END: 269, PAGEUP: 266, PAGEDOWN: 267, INSERT: 260,
    MINUS: 45, EQUAL: 61, COMMA: 44, PERIOD: 46, SLASH: 47, SEMICOLON: 59, APOSTROPHE: 39,
  }
  const resolveKey = (code) => {
    if (typeof code === 'number' && Number.isInteger(code)) return code
    const raw = String(code ?? '').trim()
    if (!raw) throw new Error('code 不能为空（给键名如 "E"/"Y"/"F5"，或 GLFW 数字码）')
    if (/^\d+$/.test(raw)) return Number(raw)
    const upper = raw.toUpperCase()
    if (Object.hasOwn(KEY_CODES, upper)) return KEY_CODES[upper]
    if (upper.length === 1) {
      const point = upper.charCodeAt(0)
      if (point >= 65 && point <= 90) return point   // A-Z 恰好就是 GLFW 65-90
      if (point >= 48 && point <= 57) return point   // 0-9 恰好就是 GLFW 48-57
    }
    const fn = /^F([1-9]|1[0-2])$/.exec(upper)
    if (fn) return 289 + Number(fn[1])               // F1=290 … F12=301
    throw new Error(`不认识的键名 "${raw}"；支持 A-Z、0-9、F1-F12、${Object.keys(KEY_CODES).join('/')}，或直接给 GLFW 数字码`)
  }

  // GUI 坐标 ≠ 窗口像素：`sirius_gui` 给的是 gui-scaled，`input.mouseMove` 要窗口像素。
  // 用一次 mouseMove 的 `gui_scaled` 反推缩放（位置追踪失焦也有效），缓存 60s。
  let guiScale = { value: null, at: 0 }
  const ensureGuiScale = async () => {
    if (guiScale.value && Date.now() - guiScale.at < 60_000) return guiScale.value
    const probe = await link.call('input.mouseMove', { x: 100, y: 100 })
    const scaledX = probe?.gui_scaled?.x
    const value = typeof scaledX === 'number' && scaledX > 0 ? 100 / scaledX : null
    if (!value || !Number.isFinite(value) || value <= 0) {
      throw new Error('无法测定 GUI 缩放（mouseMove 没返回 gui_scaled）——改用不给 at 的点击，或先 sirius_gui 看看')
    }
    guiScale = { value, at: Date.now() }
    return value
  }

  const key = defineTool({
    name: 'sirius_key',
    description:
      '按一下/按住一个键。常用：E=69 背包、T=84 聊天、ESC=256、ENTER=257、SPACE=32、SHIFT=340（潜行/疾跑）、'
      + 'W/A/S/D、1-9 切手持、F3=292。可给键名（A-Z / 0-9 / F1-F12 / 特殊键）或 GLFW 数字码。'
      + '有界面时按键会打到界面上（例如 E 关背包）。**挖掘别用它**（用 sirius_dig，动作层才稳）。'
      + '⚠️ 真机实测：`modifiers` 对绑定键与模组热键**不起作用**（Minecraft 的按键匹配读真实键盘状态，'
      + '注入的 mods 位改不了它）——需要 "Alt+某键" 的功能，请在游戏设置里把它改绑成单键再按。',
    parameters: obj({
      code: { type: 'string', description: '键名（"E"/"Y"/"F5"/"SPACE"/"SHIFT"…）或 GLFW 数字码（也可写成字符串 "69"）' },
      duration_ms: int('按住多久（毫秒）；0/不给 = 轻敲。移动用 W/S 加 duration，别超过 10000'),
      modifiers: { type: 'array', items: { type: 'string' }, description: '仅传给按键回调的 mods 位；实测对 KeyMapping/热键无效（要组合功能请改绑单键）' },
    }, ['code']),
    run: async (args) => {
      await requireInGame('按键')
      const params = { code: resolveKey(args.code) }
      if (args.duration_ms != null) params.duration_ms = Math.max(0, Math.min(60_000, Number(args.duration_ms) || 0))
      if (args.modifiers?.length) params.modifiers = args.modifiers
      const data = await link.call('input.key', params)
      return {
        summary: `按键 ${String(args.code)}（${params.code}）${params.duration_ms ? ` 按住 ${params.duration_ms}ms` : ''}`
          + `；界面${data?.screen_open ? '开着' : '关着'}`
      ,
        data,
      }
    },
  })

  const type = defineTool({
    name: 'sirius_type',
    description:
      '往当前焦点的输入框打字（中文按码点注入，不受输入法影响）。'
      + '聊天框要先 sirius_key "T" 打开；搜索框、告示牌、书与笔同理。没有输入框时打不进去（返回 delivered=0）。',
    parameters: obj({ text: str('要输入的文本（1..512 个字符）') }, ['text']),
    run: async (args) => {
      await requireInGame('输入文本')
      if (String(args.text ?? '').length === 0) throw new Error('text 不能为空')
      const data = await link.call('input.text', { string: args.text })
      return {
        summary: `输入 ${data?.delivered ?? 0}/${data?.codepoints ?? '?'} 个字符`
          + `${data?.screen_open === false ? '（当前没有输入框，没打进去）' : ''}`,
        data,
      }
    },
  })

  const click = defineTool({
    name: 'sirius_click',
    description:
      '鼠标点击。不给 at = 点当前光标；给 at = 点 sirius_gui 返回的 GUI 坐标。'
      + '协议 1.13 支持窗口失焦时直接点当前界面。hold_ms 与 count 互斥。'
      + '挖掘/放置仍用 sirius_dig / sirius_place（动作层，不受焦点影响）。',
    parameters: obj({
      at: {
        type: 'object',
        properties: { x: num('GUI 坐标 X'), y: num('GUI 坐标 Y') },
        required: ['x', 'y'],
        additionalProperties: false,
        description: '要点击的 GUI 坐标（gui-scaled，与 sirius_gui 返回的一致）',
      },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'left（默认）/ right / middle' },
      count: int('连点次数 1..8（默认 1；count=2 是双击）'),
      hold_ms: int('按住时长 0..10000（与 count 互斥；GUI 里"按住 Shift 点"这类操作用它）'),
    }),
    run: async (args) => {
      await requireInGame('点击')
      const buttonMap = { left: 0, right: 1, middle: 2 }
      const button = buttonMap[String(args.button ?? 'left')] ?? 0
      const direct = args.at && supportsGuiClick(link.protocol)
      if (args.at && !direct) {
        // 🔴 无界面时 bridge 会拒绝 mouseMove（-32013 mouse_grabbed：那会转视角）。
        //    所以 at 只在"界面开着"时才有意义，先明确检查一次，别让探测报文撞在墙上。
        const guiState = await link.call('getGuiState', {})
        if (guiState?.screen_open !== true) {
          throw new Error(
            '要给 at 点击，得先打开界面（现在没有界面）。'
            + '无界面时：转视角用 sirius_look，挖掘/放置用 sirius_dig / sirius_place，想点当前光标就不给 at。',
          )
        }
        const scale = await ensureGuiScale()
        const px = Math.round(Number(args.at.x) * scale)
        const py = Math.round(Number(args.at.y) * scale)
        const moved = await link.call('input.mouseMove', { x: px, y: py })
        const got = moved?.gui_scaled ?? {}
        const expected = { x: Number(args.at.x), y: Number(args.at.y) }
        const landed = Math.abs((got.x ?? Number.NaN) - expected.x) <= 2
          && Math.abs((got.y ?? Number.NaN) - expected.y) <= 2
        if (!landed) {
          throw new Error(
            `鼠标没落到预期位置：想要 GUI (${expected.x}, ${expected.y})，实际 (${got.x}, ${got.y})。`
            + '多半是游戏窗口没激活（失焦时 GUI 悬停不更新）——先把它切到前台再试',
          )
        }
      }
      const params = direct ? { button, at: args.at } : { button }
      if (args.hold_ms != null) params.hold_ms = Math.max(0, Math.min(10_000, Number(args.hold_ms) || 0))
      else params.count = Math.max(1, Math.min(8, Number(args.count ?? 1) || 1))
      const data = await link.call('input.click', params)
      return {
        summary: `点击 ${String(args.button ?? 'left')}${args.at ? ` @ GUI(${args.at.x}, ${args.at.y})` : '（当前光标）'}`
          + `${params.hold_ms != null ? ` 按住 ${params.hold_ms}ms` : ` ×${params.count}`}`
          + ` → clicked=${data?.clicked ?? '?'}；界面${data?.screen_open ? `开着${data.screen ? `（${data.screen}）` : ''}` : '关着'}`,
        data,
      }
    },
  })

  // Baritone 策略缓存：`#setting` 走 chat.send 后不再占聊天往返，但每条命令仍是一次 WS 调用，
  // 所以只在值真的变了才发。重连后由 plugin 置 null 以强制重发。
  // 2026-10-31 事故（用户报）：`#goto` 默认 allowBreak=true，寻路会**砸开玻璃**抄近路。
  // 所以这里默认改成"不破坏、不放置"，需要时才由调用方显式放行。
  const baritonePolicy = sharedState.baritone

  /** 后台走路跟踪器：内部运动命令优先走 Baritone API，通知走 sharedState.notify。 */
  const walkTracker = new WalkTracker({
    status: () => link.status({ timeoutMs: 6_000 }),
    call: (method, params) => link.call(method, params, { timeoutMs: 15_000 }),
    command: (text, options) => driveBaritoneCommand(text, options),
    baritone: () => probeBaritoneState(),
    notify: (text) => {
      if (typeof sharedState.notify === 'function') sharedState.notify(text)
      else log(`[walk] ${text}`)
    },
    log,
    config: sharedState.walkConfig ?? {},
  })
  sharedState.walk = walkTracker
  const followTracker = new FollowTracker({
    status: () => link.status({ timeoutMs: 6_000 }),
    baritone: () => probeBaritoneState(),
    stop: () => link.call('baritone.stop', {}, { timeoutMs: 10_000 }),
    notify: (text) => {
      if (typeof sharedState.notify === 'function') sharedState.notify(text)
      else log(`[follow] ${text}`)
    },
    log,
  })
  sharedState.follow = followTracker
  sharedState.stopBody = async () => {
    const hadWalk = walkTracker.active
    const hadFollow = followTracker.active
    await walkTracker.cancel('sirius_init')
    await followTracker.cancel('sirius_init')
    if (!hadWalk && !hadFollow) await driveBaritoneCommand('#stop', { waitMs: 300 })
  }

  /** 问一次 Baritone 的状态；拿不到只作为缺失证据，不让走路本身失败。 */
  const probeBaritoneState = async () => {
    try {
      if (!hasProtocol16()) return null
      const data = await link.call('baritone.status', {}, { timeoutMs: 8_000 })
      return data?.state ? data : null
    } catch {
      return null
    }
  }

  /** 可交互方块名：门 / 栅栏门 / 活板门 / 按钮 / 拉杆。 */  const DOOR_RE = /(?:^|:)(?:[a-z0-9_]*_)?(?:door|fence_gate|trapdoor)$|(?:button|lever)$/

  async function driveBaritoneCommand (text, options) {
    if (hasProtocol17()) {
      if (text === '#stop') return link.call('baritone.stop', {}, { timeoutMs: 10_000 })
      const match = text.match(/^#goto\s+(-?\d+)\s+(?:(-?\d+)\s+)?(-?\d+)$/)
      if (match) {
        const params = {
          x: Number(match[1]),
          z: Number(match[3]),
          allow_break: baritonePolicy.allowBreak === true,
          allow_place: baritonePolicy.allowPlace === true,
        }
        if (match[2] != null) params.y = Number(match[2])
        return link.call('baritone.goto', params, { timeoutMs: 10_000 })
      }
    }
    return sendCommand(text, options)
  }

  async function applyBaritonePolicy (allowBreak, allowPlace) {
    if (hasProtocol17()) {
      const params = {}
      if (baritonePolicy.chatControl !== false) params.chat_control = false
      if (baritonePolicy.allowBreak !== allowBreak) params.allow_break = allowBreak
      if (baritonePolicy.allowPlace !== allowPlace) params.allow_place = allowPlace
      if (Object.keys(params).length === 0) return
      const result = await link.call('baritone.settings', params, { timeoutMs: 10_000 })
      if (result?.available === false) throw new Error(`Baritone API 不可用：${result.reason ?? '需要 API 构建'}`)
      baritonePolicy.chatControl = false
      baritonePolicy.allowBreak = allowBreak
      baritonePolicy.allowPlace = allowPlace
      return
    }
    if (baritonePolicy.chatControl !== false) {
      try {
        await sendCommand('#setting chatControl false', { waitMs: 320 })
        baritonePolicy.chatControl = false
      } catch { /* 老桥继续由走路 watchdog 报告 */ }
    }
    for (const [key, value] of [['allowBreak', allowBreak], ['allowPlace', allowPlace]]) {
      if (baritonePolicy[key] === value) continue
      try {
        await sendCommand(`#setting ${key} ${value}`, { waitMs: 320 })
        baritonePolicy[key] = value
      } catch { /* 老桥继续由走路 watchdog 报告 */ }
    }
  }

  /** 附近可开的方块（门/栅栏门/活板门/按钮/拉杆），按距离升序，最多 n 个。 */
  async function nearbyOpenables (from, range = 8, n = 3) {
    let data
    try {
      data = await link.call('world.query', { type: 'blocks', range })
    } catch {
      return []
    }
    const blocks = Array.isArray(data?.blocks) ? data.blocks : []
    return blocks
      .filter((block) => typeof block?.block === 'string' && DOOR_RE.test(block.block))
      .map((block) => ({ ...block, distance: horizontal(from, block) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, n)
  }

  /**
   * 卡住时的补救：最近的门口就用 **bridge 的 use 原语**开门。
   * 不用 input.click —— use 自带转头与判定，且不受窗口焦点影响（真机硬约束）。
   * 返回成功打开的那个方块，或 null。
   */
  async function tryOpenDoor (from) {
    for (const door of await nearbyOpenables(from)) {
      try {
        const res = await link.call('use', { x: door.x, y: door.y, z: door.z })
        if (res?.result === 'used' || res?.result === 'screen_opened') return door
      } catch (error) {
        // 老 jar（协议 <1.5）没有 use：记下来，别每次卡住都白试一次
        if (/-32601|not implemented|unknown method/i.test(String(error?.message ?? error))) {
          sharedState.capabilities.hasUse = false
        }
        // out_of_reach / gui_open / rate_limited：换下一个候选
      }
    }
    return null
  }

  const walk = defineTool({
    name: 'sirius_walk',
    description:
      '走到一个坐标（直接调用 Baritone API）。默认到达指定方块格；省略 y 时只检查 X/Z。显式给 tolerance 时使用半径和 2 格高度差。'
      + '**默认不破坏方块**（allow_break=false → 通过 API 设置 allowBreak=false），也不放置方块'
      + '（allow_place=false）：寻路会绕路，走不通就停下，不再砸开墙抄近路。需要时显式 allow_break=true 放行。'
      + '卡住（4.5s 无进展）会自动找 8 格内的门/栅栏门/活板门/按钮/拉杆，用 use 打开后重试一次。'
      + '判定用**坐标位移**而不是回执。结果词表：arrived（到了）/ blocked（被方块挡住且没门可开——'
      + '报文给最近的门口坐标，可改 allow_break=true 或绕远路）/ no_progress（一步没动——多半客户端没装 '
      + 'Baritone）/ timeout（在动但没到）。总超时/取消/任何失败都会先发 #stop。'
      + '需要客户端已装 Baritone（1.21.1 / NeoForge）。',
    parameters: obj({
      x: num('目标 X（世界坐标）'),
      z: num('目标 Z（世界坐标）'),
      y: num('目标 Y（可选；不给则交给寻路器落到地表）'),
      tolerance: num('可选近似到达半径 0.5..8（格）；省略时按方块格判定'),
      timeout_ms: int('总超时 5000..180000（默认 60000）'),
      allow_break: bool('允许寻路砸方块（默认 false：不破坏，走不通就报 blocked）'),
      allow_place: bool('允许寻路放置方块垫脚/搭桥（默认 false）'),
      open_doors: bool('卡住时自动尝试开门（默认 true）'),
      background: bool('后台模式：立刻返回 started，#goto 照常发出去；到达/卡住/超时会另发通知给你（不占用这一回合）'),
    }, ['x', 'z']),
    timeoutMs: 200_000,
    run: async (args, exec) => {
      await requireReady('走路')
      await followTracker.cancel('sirius_walk')
      const timeoutMs = args.timeout_ms ?? 60_000
      const tolerance = args.tolerance ?? null
      const allowBreak = args.allow_break === true
      const allowPlace = args.allow_place === true
      const openDoors = args.open_doors !== false && sharedState.capabilities.hasUse !== false
      const stallMs = 4_500

      // 后台模式：立刻返回，走路交给 WalkTracker 在后台推进（到达/卡住/超时会通知）
      if (args.background === true) {
        await applyBaritonePolicy(allowBreak, allowPlace)
        const started = walkTracker.start({
          x: args.x,
          z: args.z,
          y: args.y ?? null,
          tolerance,
          timeoutMs,
          owner: exec?.agent?.id ?? null,
        })
        await driveBaritoneCommand(started.command, { waitMs: 500 })
        return {
          summary: `出发了（后台）：目标 (${Math.floor(args.x)}, ${Math.floor(args.z)})，`
            + `${Math.round(timeoutMs / 1000)}s 预算；到达/卡住/超时会另发一条通知（这条调用不占回合）`,
          data: {
            result: 'started',
            walk_id: started.id,
            target: started.target,
            owner: started.owner,
            command: started.command,
          },
        }
      }

      await applyBaritonePolicy(allowBreak, allowPlace)

      const startStats = await link.call('getStats', {})
      const start = startStats?.position
      if (!start || startStats?.in_game !== true) throw new Error('读不到坐标（不在世界？）')
      const target = { x: args.x, z: args.z, y: args.y ?? null }
      const goal = walkGoal(target)
      const cmd = goal.y != null ? `#goto ${goal.x} ${goal.y} ${goal.z}` : `#goto ${goal.x} ${goal.z}`
      const stop = () => driveBaritoneCommand('#stop', { waitMs: 300 }).catch(() => {})
      await driveBaritoneCommand(cmd, { waitMs: 500 })

      const t0 = Date.now()
      let last = start
      let progressAnchor = start
      let settleRetries = 0
      let lastProgressAt = Date.now()
      let resent = 0
      let opened = 0
      let bestDistance = Number.POSITIVE_INFINITY

      while (Date.now() - t0 < timeoutMs) {
        if (exec?.signal?.aborted) {
          await stop()
          throw new Error('走路已取消（已发 #stop）')
        }
        if (sharedState.canControl?.(exec?.agent?.id) === false) {
          throw new Error('身体控制权已由另一个会话通过 sirius_init 接管，本次走路终止')
        }
        await sleep(400)
        let stats
        try {
          stats = await link.call('getStats', {})
        } catch {
          continue
        }
        const p = stats?.position
        if (!p) continue
        const distance = Math.hypot(p.x - target.x, p.z - target.z)
        bestDistance = Math.min(bestDistance, distance)
        if (walkArrived(p, target, goal, tolerance)) {
          await stop()
          // 真机发现（2026-10-31）：`#stop` 不是立即刹停，还会滑 3 格左右。
          // 复核一次停稳位置，让"我到底站在哪"可信。
          await sleep(450)
          const settledStats = await link.call('getStats', {}).catch(() => null)
          const settled = settledStats?.position
          const arrived = walkArrived(settled, target, goal, tolerance)
          if (exec?.signal?.aborted || sharedState.canControl?.(exec?.agent?.id) === false) {
            throw new Error('走路已取消或控制权已变更')
          }
          if (!arrived) {
            if (settled && settleRetries++ === 0 && Date.now() - t0 < timeoutMs) {
              last = progressAnchor = settled
              lastProgressAt = Date.now()
              await driveBaritoneCommand(cmd, { waitMs: 400 })
              continue
            }
            return { summary: '停稳后未确认到达目标', data: { result: 'off_target', from: start, to: settled ?? null, target, goal } }
          }
          const settledDistance = Math.hypot(settled.x - target.x, settled.z - target.z)
          return {
            summary: `到达 (${args.x}, ${args.z})：剩余 ${distance.toFixed(2)} 格，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
              + `；停稳于 ${settled.x.toFixed(1)}, ${settled.z.toFixed(1)}（距目标 ${settledDistance.toFixed(2)} 格）`
              + `${resent ? `，中途重发 ${resent} 次 #goto` : ''}${opened ? `，途中开了 ${opened} 扇门` : ''}`,
            data: {
              result: 'arrived',
              distance,
              settled_distance: settledDistance,
              vertical_distance: target.y == null ? null : Math.abs(settled.y - target.y),
              from: start,
              to: settled,
              elapsed_ms: Date.now() - t0,
              resent,
              opened,
              allow_break: allowBreak,
            },
          }
        }
        if (walkDistance(progressAnchor, p, target.y != null) >= 0.75) {
          progressAnchor = last = p
          lastProgressAt = Date.now()
          continue
        }
        last = p
        if (Date.now() - lastProgressAt < stallMs) continue

        // --- 卡住了。先分清"压根没动"（Baritone 没装/命令没进去）与"被挡住"
        const moved = walkDistance(start, last, target.y != null)
        const baritoneState = await probeBaritoneState()
        if (baritoneState?.state === 'calculating' && Date.now() - lastProgressAt < 15000) continue
        if (baritoneState?.state === 'arrived') {
          await stop()
          return { summary: '寻路已结束，实际位置偏离目标', data: { result: 'off_target', from: start, to: last, target, goal, baritone: baritoneState } }
        }
        if (moved < 1 || baritoneState?.state === 'no_path') {
          await stop()
          // 1.6：问一次 Baritone 自己在干什么。`no_path` 说明它算不出路（旁边没路/目标不可达），
          // 这和"没装 Baritone"是两回事，教学话术必须分开，否则模型会一直重试同一条路。
          const noPath = baritoneState?.state === 'no_path'
          return {
            summary: noPath
              ? `一步没动：Baritone 算不出路（${short(baritoneState.last_line ?? '', 60) || 'no path'}）`
                + '——目标进不去或周围被封住了，换个落点（先在门口 / 同层）再试'
              : `一步没动（${((Date.now() - t0) / 1000).toFixed(1)}s 内位移 ${moved.toFixed(2)} 格）`
                + '——检查客户端是否装了 Baritone，或目标落点在实心方块里',
            data: {
              result: noPath ? 'no_path' : 'no_progress',
              moved,
              from: start,
              to: last,
              elapsed_ms: Date.now() - t0,
              allow_break: allowBreak,
              baritone: baritoneState,
            },
          }
        }
        const doors = openDoors ? await nearbyOpenables(last) : []
        if (openDoors) {
          const door = await tryOpenDoor(last)
          if (door) {
            opened += 1
            lastProgressAt = Date.now()
            await driveBaritoneCommand(cmd, { waitMs: 400 }).catch(() => {})
            continue
          }
        }
        await stop()
        const nearest = doors[0] ?? null
        const remaining = Math.hypot(last.x - target.x, last.z - target.z)
        // 三种情况要分清：本来就没让开门 / 对端没有 use 原语 / 试了但打不开
        const doorHint = !openDoors
          ? (args.open_doors === false
            ? '；open_doors=false，没去试门'
            : '；门兜底不可用（对端 bridge <1.5，没有 use 原语）')
          : nearest
            ? `；最近的可开方块 ${nearest.block} 在 (${nearest.x}, ${nearest.y}, ${nearest.z})，`
              + `距 ${nearest.distance.toFixed(1)} 格，试过但没打开`
            : '；8 格内没有门/栅栏门/活板门/按钮'
        return {
          summary: `被挡住：停在 ${last.x.toFixed(1)}, ${last.z.toFixed(1)}，距目标 ${remaining.toFixed(2)} 格`
            + doorHint
            + (allowBreak ? '（allow_break=true 也没过去，可能不是方块挡的）' : '。要允许砸方块可传 allow_break=true'),
          data: {
            result: 'blocked',
            distance: remaining,
            best_distance: Number.isFinite(bestDistance) ? bestDistance : null,
            moved,
            nearest_door: nearest,
            doors_seen: doors.length,
            opened,
            from: start,
            to: last,
            elapsed_ms: Date.now() - t0,
            allow_break: allowBreak,
          },
        }
      }

      await stop()
      const remaining = Math.hypot(last.x - target.x, last.z - target.z)
      const moved = horizontal(start, last)
      return {
        summary: `超时：${timeoutMs}ms 未到达，最后距目标 ${remaining.toFixed(2)} 格（已发 #stop）`,
        data: {
          result: 'timeout',
          distance: remaining,
          best_distance: Number.isFinite(bestDistance) ? bestDistance : remaining,
          moved,
          from: start,
          to: last,
          elapsed_ms: Date.now() - t0,
          resent,
          opened,
          allow_break: allowBreak,
        },
      }
    },
  })

  const tunnel = defineTool({
    name: 'sirius_tunnel',
    description:
      '朝当前水平朝向挖一条隧道（直接调用 Baritone Builder API，不使用 mine）。从脚下开始，height 至少 2，width/depth 至少 1。'
      + '会挖掉范围内的方块，开始前必须确认周围不是别人的建筑；不允许寻路放置方块。'
      + '桥侧监视 BuilderProcess 并复核目标区域，结束/取消/接管后恢复 allowBreak=false、allowPlace=false。'
      + '结果词表：done / blocked / no_path / no_progress / timeout / interrupted / not_in_game。',
    parameters: obj({
      height: int('隧道高度 2..16 格'),
      width: int('隧道宽度 1..16 格'),
      depth: int('隧道深度 1..256 格'),
      timeout_ms: int('总超时 5000..300000（默认 120000）'),
    }, ['height', 'width', 'depth']),
    timeoutMs: 330_000,
    run: async (args, exec) => {
      await requireReady('挖隧道')
      requireProtocol17('挖隧道')
      const height = Number(args.height)
      const width = Number(args.width)
      const depth = Number(args.depth)
      if (!Number.isInteger(height) || height < 2 || height > 16) throw new Error('height 必须是 2..16 的整数')
      if (!Number.isInteger(width) || width < 1 || width > 16) throw new Error('width 必须是 1..16 的整数')
      if (!Number.isInteger(depth) || depth < 1 || depth > 256) throw new Error('depth 必须是 1..256 的整数')
      const timeoutMs = Number.isFinite(Number(args.timeout_ms))
        ? Math.max(5_000, Math.min(300_000, Number(args.timeout_ms)))
        : 120_000
      const startStats = await link.call('getStats', {})
      const start = startStats?.position
      if (!start || startStats?.in_game !== true || !Number.isFinite(startStats?.yaw)) {
        throw new Error('读不到当前坐标或朝向，无法确定隧道起点')
      }
      const directions = [
        { x: 0, z: 1, name: 'south' },
        { x: -1, z: 0, name: 'west' },
        { x: 0, z: -1, name: 'north' },
        { x: 1, z: 0, name: 'east' },
      ]
      const direction = directions[((Math.round(startStats.yaw / 90) % 4) + 4) % 4]
      const startedAt = Date.now()
      const stopTunnel = () => driveBaritoneCommand('#stop', { waitMs: 300 }).catch(() => {})
      let lastPosition = start
      let bestProjection = 0

      const finish = (result, reason = null, task = null) => ({
        summary: `隧道 ${height}×${width}×${depth} → ${result}（朝向 ${direction.name}，水平推进 ${bestProjection.toFixed(1)} 格，`
          + `用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）${reason ? `；${reason}` : ''}`,
        data: {
          result,
          operation: 'baritone.tunnel',
          operation_id: task?.operation_id ?? null,
          height,
          width,
          depth,
          direction: task?.direction ?? direction.name,
          progress: task?.progress ?? bestProjection,
          from: start,
          to: lastPosition,
          elapsed_ms: Date.now() - startedAt,
          allow_break: true,
          allow_place: false,
          ...(task?.region ? { region: task.region } : {}),
          ...(task?.remaining != null ? { remaining: task.remaining } : {}),
          ...(reason ? { reason } : {}),
        },
      })

      await applyBaritonePolicy(true, false)
      try {
        const started = await link.call('baritone.tunnel', { height, width, depth, timeout_ms: timeoutMs })
        if (started?.result !== 'started') {
          throw new Error(`Baritone 隧道启动失败：${started?.reason ?? started?.result ?? 'unknown'}`)
        }
        const operationId = started.operation_id
        while (Date.now() - startedAt < timeoutMs + 2000) {
          if (exec?.signal?.aborted) {
            await stopTunnel()
            throw new Error('挖隧道已取消（已停止 API 任务，并恢复安全寻路设置）')
          }
          if (sharedState.canControl?.(exec?.agent?.id) === false) {
            await stopTunnel()
            throw new Error('身体控制权已由另一个会话通过 sirius_init 接管，本次挖隧道终止')
          }
          await sleep(400)
          const stats = await link.call('getStats', {}).catch(() => null)
          if (stats?.in_game === false) {
            await stopTunnel()
            return finish('not_in_game', '不在游戏里了')
          }
          const position = stats?.position
          if (position) {
            const projection = (position.x - start.x) * direction.x + (position.z - start.z) * direction.z
            bestProjection = Math.max(bestProjection, projection)
            lastPosition = position
          }
          const state = await probeBaritoneState()
          const task = state?.tunnel
          if (task?.operation_id === operationId && task.active === false) {
            return finish(task.result ?? 'blocked', task.reason, task)
          }
        }
        await stopTunnel()
        return finish('timeout', `超过 ${timeoutMs}ms（已停止 API 任务）`)
      } finally {
        await applyBaritonePolicy(false, false).catch(() => {})
      }
    },
  })

  // ---------------------------------------------------------------- 动作

  const stop = defineTool({
    name: 'sirius_stop',
    description:
      '系统级停止：取消所有插件/脚本 run 和后台 walk/follow，发 Baritone stop，停稳后复核位置（会滑 3 格左右）。'
      + '要抢占身体做原地动作（挖/放/用）之前、或者后台移动走错方向时先调它。',
    parameters: obj(),
    run: async () => {
      await requireInGame('停下')
      const hadWalk = walkTracker.active
      const hadFollow = followTracker.active
      await walkTracker.cancel('sirius_stop')
      await followTracker.cancel('sirius_stop')
      await sharedState.scripts?.retireAll('sirius_stop')
      if (!hadWalk && !hadFollow) await driveBaritoneCommand('#stop', { waitMs: 300 })
      await sleep(450)
      const after = await link.call('getStats', {}).catch(() => null)
      const pos = after?.position ?? null
      const result = hadFollow ? 'stopped_follow' : hadWalk ? 'stopped_walk' : 'stopped'
      return {
        summary: `已停${hadWalk || hadFollow ? '（后台移动任务已注销）' : ''}，停稳在 `
          + `${pos ? `${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}` : '（读不到坐标）'}`,
        data: { result, position: pos },
      }
    },
  })

  const follow = defineTool({
    name: 'sirius_follow',
    description:
      '跟随一个玩家（Baritone FollowProcess API）。uuid 或 name 必须二选一，name 精确匹配（不区分大小写），不会跟随所有玩家。'
      + 'follow_radius 默认 10 格，可在 1..64 之间逐次调整；allow_break/allow_place 默认 false。'
      + '立即返回 following 或 target_not_found。后台每 2 秒检查，目标丢失或持续 4.5 秒无进展会停止并另发提醒。'
      + '停止用 sirius_stop；开始新的 walk/follow 会取代当前跟随。用 sirius_baritone 查看实时跟随状态。',
    parameters: obj({
      uuid: str('目标玩家 UUID（与 name 二选一，推荐）'),
      name: str('目标玩家名（与 uuid 二选一，精确匹配，不区分大小写）'),
      follow_radius: int('跟随半径 1..64 格（默认 10）'),
      allow_break: bool('允许跟随途中破坏方块（默认 false）'),
      allow_place: bool('允许跟随途中放置方块（默认 false）'),
    }),
    timeoutMs: 25_000,
    run: async (args, exec) => {
      await requireReady('跟随玩家')
      requireProtocol19('跟随玩家')
      const uuid = typeof args.uuid === 'string' && args.uuid.trim() ? args.uuid.trim() : null
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null
      if ((uuid === null) === (name === null)) throw new Error('uuid 与 name 必须二选一，且不能都为空')
      const followRadius = Number(args.follow_radius ?? 10)
      if (!Number.isInteger(followRadius) || followRadius < 1 || followRadius > 64) {
        throw new Error('follow_radius 必须是 1..64 的整数')
      }
      await walkTracker.cancel('sirius_follow')
      await followTracker.cancel('sirius_follow', { stop: false })
      const params = { follow_radius: followRadius, allow_break: args.allow_break === true, allow_place: args.allow_place === true }
      if (uuid) params.uuid = uuid
      else params.name = name
      const data = await link.call('baritone.follow', params, { timeoutMs: 15_000 })
      if (data?.result === 'following') {
        followTracker.start({ target: data.target, followRadius, owner: exec?.agent?.id ?? null })
      }
      const who = data?.target?.name ?? name ?? uuid
      return {
        summary: data?.result === 'following'
          ? `开始跟随 ${who}，半径 ${followRadius} 格；目标丢失或卡住会另发提醒，停止用 sirius_stop`
          : `没有找到玩家 ${who}：目标不在客户端实体追踪范围内`,
        data,
      }
    },
  })

  const look = defineTool({
    name: 'sirius_look',
    description:
      '看向某处。给 at（世界坐标，推荐，可带平滑角速度）用 lookAt；给 yaw/pitch 用绝对朝向。'
      + '看向一律走这里——鼠标移动在窗口未激活时不生效。',
    parameters: obj({
      at: {
        type: 'object',
        properties: { x: num('X'), y: num('Y'), z: num('Z') },
        required: ['x', 'y', 'z'],
        additionalProperties: false,
        description: '要看向的世界坐标',
      },
      yaw: num('绝对偏航角 -180..180（0=南，-90=东）'),
      pitch: num('绝对俯仰角 -90..90（负数抬头）'),
      turn_speed_deg_s: num('平滑转头角速度 30..720（度/秒），不给则瞬间转'),
    }),
    run: async (args) => {
      await requireReady('转头')
      if (args.at) {
        const params = { x: args.at.x, y: args.at.y, z: args.at.z }
        if (args.turn_speed_deg_s != null) params.turn_speed_deg_s = args.turn_speed_deg_s
        const data = await link.call('lookAt', params, { timeoutMs: 20_000 })
        return { summary: `看向 ${short(args.at, 40)}：yaw=${data?.yaw}° pitch=${data?.pitch}° 距离 ${data?.distance}`, data }
      }
      if (args.yaw == null || args.pitch == null) {
        throw new Error('要么给 at（世界坐标），要么同时给 yaw 与 pitch')
      }
      const data = await link.call('look', { yaw: args.yaw, pitch: args.pitch })
      return { summary: `朝向已设为 yaw=${data?.yaw}° pitch=${data?.pitch}°`, data }
    },
  })

  const dig = defineTool({
    name: 'sirius_dig',
    description:
      '挖掉一个方块（智能原语：自动瞄准、遮挡容忍、挖不动会给原因）。'
      + '结果词表：broken / already_air / timeout / not_digging / blocked_liquid / blocked_falling。'
      + '目标超过 4.5 格会报"走近一点"。',
    parameters: obj({
      x: int('方块 X'),
      y: int('方块 Y'),
      z: int('方块 Z'),
      timeout_ms: int('超时 600..30000（默认 15000）'),
    }, ['x', 'y', 'z']),
    timeoutMs: 45_000,
    run: async (args) => {
      await requireReady('挖掘')
      const params = { x: args.x, y: args.y, z: args.z }
      if (args.timeout_ms != null) params.timeout_ms = args.timeout_ms
      const data = await link.call('dig', params, { timeoutMs: (args.timeout_ms ?? 15_000) + 20_000 })
      return {
        summary: `挖掘(${args.x},${args.y},${args.z}) → ${data?.result}${data?.block ? ` [${data.block}]` : ''}`
          + `${data?.elapsed_ms != null ? ` ${data.elapsed_ms}ms` : ''}${data?.reason ? `：${data.reason}` : ''}`
          + `${data?.drops?.length ? `；掉落 ${short(data.drops, 80)}` : ''}`,
        data,
      }
    },
  })

  const place = defineTool({
    name: 'sirius_place',
    description:
      '放一个方块。坐标是**目标格**（新方块所在的位置），face 指支撑方块在目标格的哪一侧（默认 down = 放在地面/方块顶上）。'
      + '结果词表：placed / already_placed / blocked / support_missing / no_item / not_in_hotbar / out_of_reach / gui_open / timeout / not_placing。'
      + '指定 item 时：快捷栏里没有、但主背包里有 → 桥会**自动换到当前选中格**再放，不用你先手搓 GUI；'
      + '换不动才回 not_in_hotbar（那时才需要自己挪）。',
    parameters: obj({
      x: int('目标格 X'),
      y: int('目标格 Y'),
      z: int('目标格 Z'),
      face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: '支撑方块相对目标格的方向，默认 down' },
      item: str('要用的方块物品（registry 名）；不给则用当前手持'),
      timeout_ms: int('超时 600..10000（默认 3000）'),
    }, ['x', 'y', 'z']),
    timeoutMs: 30_000,
    run: async (args) => {
      await requireReady('放置')
      const params = { x: args.x, y: args.y, z: args.z }
      if (args.face) params.face = args.face
      if (args.item) params.item = args.item
      if (args.timeout_ms != null) params.timeout_ms = args.timeout_ms
      const data = await link.call('place', params, { timeoutMs: (args.timeout_ms ?? 3000) + 18_000 })
      return {
        summary: `放置(${args.x},${args.y},${args.z},face=${data?.face ?? args.face ?? 'down'}) → ${data?.result}`
          + `${data?.block ? ` [${data.block}]` : ''}${data?.slot != null ? ` slot=${data.slot}` : ''}`
          + `${data?.reason ? `：${data.reason}` : ''}`,
        data,
      }
    },
  })

  const use = defineTool({
    name: 'sirius_use',
    description:
      '右键使用一个方块：开箱子/木桶/工作台/熔炉/附魔台/门/活板门/栅栏门/按钮/拉杆/床/模组机器。'
      + '桥会自己平滑转头对准那一面（300°/s）并走动作层发包——**不要**先 sirius_look，也**不要**用 sirius_click 手搓右键。'
      + '坐标是**被点的那格方块**；face 是点它的哪一面（省略 = 朝向你的那一面，桥会回显解析结果）。'
      + '返回三件事：result（used / screen_opened / no_effect / rejected / out_of_reach / gui_open / not_using）、'
      + 'effect（证据：screen / block_changed / none_visible）、interaction（success / consume / pass / fail）。'
      + 'result=screen_opened 时**界面已经开着**，接着用 sirius_gui 读槽位；别原地再点一次（会回 gui_open）。'
      + 'no_effect + interaction=pass = 这个方块没有交互：换面、换方块，或它本来就没用。'
      + 'used + effect=none_visible = 游戏接受了但暂时看不见（吃东西、点火、延迟生效的模组）——不要因此重试。',
    parameters: obj({
      x: int('目标方块 X'),
      y: int('目标方块 Y'),
      z: int('目标方块 Z'),
      face: {
        type: 'string',
        enum: ['up', 'down', 'north', 'south', 'east', 'west'],
        description: '点目标方块的哪一面；省略 = 朝向你的那一面',
      },
      hand: { type: 'string', enum: ['main', 'off'], description: '用哪只手：main（默认）/ off（盾牌、图腾、双持）' },
      timeout_ms: int('超时 600..10000（默认 2000）'),
    }, ['x', 'y', 'z']),
    timeoutMs: 25_000,
    run: async (args) => {
      // 用 requireInGame 而不是 requireReady：界面开着时 bridge 会回 gui_open，
      // 这本身就是有用的信息（"先关界面再点"），别在工具层提前拦成异常。
      await requireInGame('使用方块')
      const params = { x: args.x, y: args.y, z: args.z }
      if (args.face) params.face = args.face
      if (args.hand) params.hand = args.hand
      if (args.timeout_ms != null) params.timeout_ms = args.timeout_ms
      const data = await link.call('use', params, { timeoutMs: (args.timeout_ms ?? 2000) + 15_000 })
      const bits = [`interaction=${data?.interaction ?? '?'}`]
      if (data?.effect) bits.push(`证据=${data.effect}`)
      if (data?.screen_class) bits.push(`界面=${data.screen_class}`)
      return {
        summary: `使用(${args.x},${args.y},${args.z}${data?.face ? `,face=${data.face}` : ''}) → ${data?.result}`
          + `${data?.block ? ` [${data.block}]` : ''}（${bits.join('，')}）`
          + `${data?.reason ? `；${data.reason}` : ''}`,
        data,
      }
    },
  })

  // ---------------------------------------------------------------- 1.6 新增的动作与感知

  const select = defineTool({
    name: 'sirius_select',
    description:
      '切换快捷栏选中格（0..8）。换手持物品时用它，**不要**去点 GUI 里的槽位。'
      + '只看不换手时用 sirius_inventory；要在主背包里找东西放到手上，先 sirius_inventory 查槽位再走 GUI（目前没有搬运原语）。',
    parameters: obj({ slot: int('快捷栏下标 0..8') }, ['slot']),
    run: async (args) => {
      await requireInGame('切换选中格')
      requireProtocol16('切换选中格')
      const data = await link.call('inventory.select', { slot: args.slot })
      const item = data?.item ? `${withDisplay(data.item.name, data.item.display)}×${data.item.count}` : '空手'
      return {
        summary: `选中格 ${data?.previous ?? '?'} → ${data?.selected ?? args.slot}（${item}）`,
        data,
      }
    },
  })

  const useItem = defineTool({
    name: 'sirius_use_item',
    description:
      '用一下**手里**的东西（不需要目标方块）：吃东西、穿盔甲/换装、甩钓竿、用剪刀、倒桶、扔珍珠。'
      + '方块交互仍用 sirius_use，实体交互用 sirius_use_entity——别拿这个代替它们。'
      + '**吃/喝/拉弓这类需要"按住"的动作由桥自己按到进度条走完再松**（食物约 1.6s），'
      + '一次调用就是一次完整使用，不要为了"多吃两口"重复调用（要连吃用 times）。'
      + '结果词表：used / incomplete / no_effect / screen_opened / gui_open / not_in_game / not_using / timeout；'
      + '证据看 item_before / item_after（吃东西会 -1）、food_before / food_after、hold_ticks、interaction。'
      + 'incomplete = 按下被接受了但物品/饱食/饱和/装备都没变（多半是饱食已满或被服务端拒绝），别当成吃成了。',
    parameters: obj({
      hand: { type: 'string', enum: ['main', 'off'], description: '用哪只手：main（默认）/ off' },
      times: int('连按几次 1..10（默认 1）'),
      interval_ms: int('两次之间隔多少毫秒 0..5000（默认 300）'),
      timeout_ms: int('总超时 200..10000（默认 2000）'),
    }),
    timeoutMs: 25_000,
    run: async (args) => {
      await requireInGame('使用物品')
      requireProtocol16('使用物品')
      const params = { hand: args.hand ?? 'main' }
      if (args.times != null) params.times = args.times
      if (args.interval_ms != null) params.interval_ms = args.interval_ms
      if (args.timeout_ms != null) params.timeout_ms = args.timeout_ms
      const data = await link.call('useItem', params, { timeoutMs: (args.timeout_ms ?? 2000) + 15_000 })
      const bits = [`interaction=${data?.interaction ?? '?'}`]
      if (data?.item_before?.name) bits.push(`手里 ${data.item_before.name}×${data.item_before.count}→${data?.item_after?.count ?? '?'}`)
      if (Number.isFinite(data?.hold_ticks) && data.hold_ticks > 0) bits.push(`按住 ${data.hold_ticks} tick`)
      if (Number.isFinite(data?.food_before) && Number.isFinite(data?.food_after)
        && data.food_after !== data.food_before) {
        bits.push(`饱食 ${data.food_before}→${data.food_after}`)
      }
      if (data?.screen_class) bits.push(`界面=${data.screen_class}`)
      // incomplete 是 1.6.2 新增词：按下被受理但什么都没变（以前这里会谎报 used）
      const note = data?.result === 'incomplete'
        ? '（没吃成/没用成：物品、饱食、饱和度、装备都没变化 —— 别原地重试，先看是不是饱食已满）'
        : ''
      return {
        summary: `用物品(${params.hand}${args.times ? `×${args.times}` : ''}) → ${data?.result}${note}（${bits.join('，')}）`,
        data,
      }
    },
  })

  /** 实体目标的参数（use_entity / attack 共用）：uuid / name / 半径内最近。 */
  const entityRef = (args) => {
    const params = {}
    if (args.uuid) params.uuid = args.uuid
    if (args.name) params.name = args.name
    if (args.radius != null) params.radius = args.radius
    return params
  }

  const useEntity = defineTool({
    name: 'sirius_use_entity',
    description:
      '右键一个**实体**：递东西、喂动物、挤奶、剪羊毛、跟村民交易、上马/上船、给盔甲架穿装备。'
      + '目标三种给法：uuid / name / 都不给则半径内最近。'
      + '**不用先对准星**——服务端只校验"够不够得着（3 格）"，桥会自己算朝向并走动作层发包。'
      + '结果词表：used / screen_opened（交易、马、船）/ no_effect（这实体不接受）/ out_of_range（附还差几格）/ '
      + 'gone（实体不见了）/ gui_open / not_in_game。',
    parameters: obj({
      uuid: str('实体 uuid（最精确，来自 sirius_world 的 entities）'),
      name: str('实体名字（精确优先，其次大小写不敏感包含）'),
      radius: num('都没给就用半径内最近的实体（默认 6，上限 64）'),
      hand: { type: 'string', enum: ['main', 'off'], description: '用哪只手：main（默认）/ off' },
      at: { type: 'string', enum: ['auto', 'center'], description: '点击方式：auto（默认）/ center（盔甲架、挂画这类要精确点）' },
      timeout_ms: int('超时 200..10000（默认 2000）'),
    }),
    timeoutMs: 25_000,
    run: async (args) => {
      await requireInGame('右键实体')
      requireProtocol16('右键实体')
      const params = entityRef(args)
      if (args.hand) params.hand = args.hand
      if (args.at) params.at = args.at
      if (args.timeout_ms != null) params.timeout_ms = args.timeout_ms
      const data = await link.call('entity.use', params, { timeoutMs: (args.timeout_ms ?? 2000) + 15_000 })
      const who = data?.entity ? `${data.entity.name ?? data.entity.type}（${data.entity.distance?.toFixed?.(1) ?? '?'} 格）` : '?'
      return {
        summary: `右键 ${who} → ${data?.result}`
          + `${data?.screen_class ? `（界面=${data.screen_class}）` : ''}`
          + `${data?.reason ? `；${data.reason}` : ''}`,
        data,
      }
    },
  })

  const attack = defineTool({
    name: 'sirius_attack',
    description:
      '左键攻击一个**实体**（同理不用对准星，服务端只校验距离）。'
      + 'wait_cooldown 默认开启：会等攻击冷却满了再打，否则伤害衰减还吃攻击速率惩罚。'
      + 'until=dead 时持续攻击同一个目标，直到死亡、消失、超距、自己低血或超时；不会自动追怪。'
      + '结果词表：hit（附 hits 数）/ out_of_range / gone / dead / low_health / timeout / interrupted / target_unstable / not_in_game。',
    parameters: obj({
      uuid: str('实体 uuid（最精确，来自 sirius_world 的 entities）'),
      name: str('实体名字（精确优先，其次大小写不敏感包含）'),
      radius: num('都没给就用半径内最近的实体（默认 6，上限 64）'),
      until: { type: 'string', enum: ['hits', 'dead'], description: 'hits=按 count 连击（默认）；dead=持续攻击同一目标直到终局' },
      count: int('until=hits 时的连击次数 1..10（默认 1）；until=dead 时固定逐次攻击'),
      interval_ms: int('两次攻击间隔 0..5000（默认 600）'),
      wait_cooldown: bool('是否等攻击冷却（默认 true）'),
      max_seconds: num('until=dead 的总时限 1..300 秒（默认 60）'),
      min_health: num('until=dead 时自己血量不高于此值就收手 0..20（默认 8）'),
    }),
    timeoutMs: 360_000,
    run: async (args, exec) => {
      const initialStatus = await requireInGame('攻击实体')
      requireProtocol16('攻击实体')
      const params = entityRef(args)
      if (args.interval_ms != null) params.interval_ms = args.interval_ms
      if (args.wait_cooldown != null) params.wait_cooldown = args.wait_cooldown

      if (args.until !== 'dead') {
        if (args.count != null) params.count = args.count
        const data = await link.call('entity.attack', params, { timeoutMs: 25_000 })
        const who = data?.entity ? `${data.entity.name ?? data.entity.type}` : '?'
        return {
          summary: `攻击 ${who} → ${data?.result}（命中 ${data?.hits ?? 0} 次${data?.miss ? `，落空 ${data.miss}` : ''}）`,
          data,
        }
      }

      const maxSeconds = Number.isFinite(Number(args.max_seconds))
        ? Math.max(1, Math.min(300, Number(args.max_seconds)))
        : 60
      const minHealth = Number.isFinite(Number(args.min_health))
        ? Math.max(0, Math.min(20, Number(args.min_health)))
        : 8
      const startedAt = Date.now()
      let attempts = 0
      let hits = 0
      let miss = 0
      let target = null
      let targetHealthBefore = null
      let targetHealthAfter = null
      let playerHealth = Number.isFinite(initialStatus.health) ? initialStatus.health : null

      const finish = (result, last = null, reason = null) => {
        const who = target?.name ?? target?.type ?? '?'
        const healthEvidence = targetHealthBefore !== null
          ? `，目标血量 ${targetHealthBefore}→${targetHealthAfter ?? '?'}`
          : ''
        return {
          summary: `攻击 ${who} → ${result}（${attempts} 轮，命中 ${hits} 次${miss ? `，落空 ${miss}` : ''}`
            + `${healthEvidence}，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）${reason ? `；${reason}` : ''}`,
          data: {
            ...(last ?? {}),
            result,
            until: 'dead',
            attempts,
            hits,
            miss,
            elapsed_ms: Date.now() - startedAt,
            ...(target ? { entity: target } : {}),
            target_health_before: targetHealthBefore,
            target_health_after: targetHealthAfter,
            player_health: playerHealth,
            max_seconds: maxSeconds,
            min_health: minHealth,
            ...(reason ? { reason } : {}),
          },
        }
      }

      if (playerHealth !== null && playerHealth <= minHealth) {
        return finish('low_health', null, `自己血量 ${playerHealth}/20，不高于收手阈值 ${minHealth}`)
      }

      params.count = 1
      while (true) {
        if (exec?.signal?.aborted) return finish('interrupted', null, '调用方取消了持续攻击')
        if (sharedState.canControl?.(exec?.agent?.id) === false) {
          return finish('interrupted', null, '身体控制权已由另一个会话通过 sirius_init 接管')
        }
        if (Date.now() - startedAt >= maxSeconds * 1000) {
          return finish('timeout', null, `持续攻击超过 ${maxSeconds}s`)
        }

        const data = await link.call('entity.attack', params, { timeoutMs: 25_000 })
        attempts += 1
        const roundHits = Number(data?.hits)
        const roundMiss = Number(data?.miss)
        hits += Number.isFinite(roundHits) ? roundHits : (data?.result === 'hit' ? 1 : 0)
        miss += Number.isFinite(roundMiss) ? roundMiss : 0
        if (data?.entity) {
          target = { ...target, ...data.entity }
          if (Number.isFinite(data.entity.health)) {
            if (targetHealthBefore === null) targetHealthBefore = data.entity.health
            targetHealthAfter = data.entity.health
          }
        }

        if (data?.result === 'dead' || data?.result === 'gone') return finish(data.result, data)
        if (data?.result === 'hit' && targetHealthAfter !== null && targetHealthAfter <= 0) {
          return finish('dead', data)
        }
        if (data?.result !== 'hit') return finish(data?.result ?? 'unknown', data)

        if (!params.uuid) {
          if (!target?.uuid) {
            return finish('target_unstable', data, '桥没有返回实体 uuid，无法保证下一轮仍攻击同一个目标')
          }
          params.uuid = target.uuid
          delete params.name
          delete params.radius
        }

        try {
          const status = await link.status({ timeoutMs: 6_000 })
          if (Number.isFinite(status?.health)) playerHealth = status.health
          if (status?.online === false || status?.inGame === false) return finish('not_in_game', data)
        } catch { /* 状态取证失败不中断已经成立的攻击循环 */ }
        if (playerHealth !== null && playerHealth <= minHealth) {
          return finish('low_health', data, `自己血量 ${playerHealth}/20，已不高于收手阈值 ${minHealth}`)
        }

        const interval = Math.max(0, Math.min(5_000, Number(args.interval_ms ?? 600) || 0))
        if (interval > 0) await sleep(interval)
      }
    },
  })

  const baritone = defineTool({
    name: 'sirius_baritone',
    description:
      '直接读取 Baritone API 状态，不解析聊天回执。'
      + 'state：following（正在跟随）/ pathing（正在走）/ calculating（算路中）/ no_path / arrived / idle / unknown；'
      + '还会给 goal、PathEvent、BuilderProcess、隧道与 follow.active/targets/radius。走路或跟随异常时先查它。',
    parameters: obj(),
    timeoutMs: 20_000,
    run: async () => {
      requireProtocol17('查 Baritone 状态')
      const data = await link.call('baritone.status', {})
      const event = data?.last_event ?? data?.last_line
      const following = data?.follow?.active === true
        ? `；跟随 ${(data.follow.targets ?? []).map((entry) => entry.name ?? entry.uuid).join('/')}，半径 ${data.follow.radius}`
        : ''
      return {
        summary: `Baritone: ${data?.state ?? 'unknown'}`
          + `${data?.goal ? ` 目标 ${short(data.goal, 40)}` : ''}`
          + following
          + `${event ? `；最近事件：${event}` : ''}`
          + `${data?.available === false ? '；⚠ Baritone API 不可用（需要 API 构建）' : ''}`,
        data,
      }
    },
  })

  const chatHistory = defineTool({
    name: 'sirius_chat_history',
    description:
      '读聊天记录（含**客户端本地消息**：Baritone 回执、登录插件提示、模组提示——这些不在 sirius_events 里）。'
      + 'source：all（默认）/ server / client；regex 按整行过滤；since_ms 只要这个时间之后的。'
      + '适合"刚才那条提示到底是什么"这种核对，不要用它代替 sirius_events 的事件订阅。',
    parameters: obj({
      limit: int('最多几条 1..200（默认 40）'),
      regex: str('Java 正则，按整行过滤'),
      source: { type: 'string', enum: ['all', 'server', 'client'], description: '消息来源，默认 all' },
      since_ms: int('只要这个时间戳（epoch 毫秒）之后的'),
    }),
    timeoutMs: 20_000,
    run: async (args) => {
      requireProtocol16('读聊天记录')
      const params = {}
      if (args.limit != null) params.limit = args.limit
      if (args.regex) params.regex = args.regex
      if (args.source) params.source = args.source
      if (args.since_ms != null) params.since_ms = args.since_ms
      const data = await link.call('chat.history', params)
      const lines = (data?.lines ?? []).slice(-6).map((row) => `${row.source === 'client' ? '·' : '>' } ${short(row.text, 70)}`)
      return {
        summary: `聊天 ${data?.count ?? 0} 条${data?.captured === false ? '（⚠ 客户端聊天捕获不可用）' : ''}`
          + `${lines.length ? `：${lines.join(' | ')}` : ''}`,
        data,
      }
    },
  })

  // ---------------------------------------------------------------- 事件

  const events = defineTool({
    name: 'sirius_events',
    description:
      '游戏事件：先订阅，再读最近的推送（内存里留 200 条）。'
      + '默认种类：chat / gui_open / gui_close / death / damage / fire / health_low / drown。'
      + '也可显式订阅 1.11 的 block/entity/item/player/window/slot/held_item/connection/baritone 原始事件。'
      + '它**不会**主动叫醒你——想等事件就用 wait_ms 阻塞一会儿；长期监听请用 sirius_script 后台运行。',
    parameters: obj({
      types: { type: 'array', items: { type: 'string' }, description: '要订阅的种类，默认 chat/gui/death/damage/fire/health_low/drown' },
      since: int('只返回 seq 大于它的（默认 -1 = 全部）'),
      limit: int('最多返回多少条（默认 20）'),
      wait_ms: int('阻塞等待新事件的最长时间（0..30000，默认 0 = 不等待）'),
    }),
    timeoutMs: 40_000,
    run: async (args) => {
      const types = args.types?.length ? args.types : ['chat', 'gui_open', 'gui_close', 'death', 'damage', 'fire', 'health_low', 'drown']
      await link.subscribe(types)
      const since = args.since ?? -1
      const limit = args.limit ?? 20
      let rows = link.events({ since, types, limit })
      if (rows.length === 0 && (args.wait_ms ?? 0) > 0) {
        const deadline = Date.now() + args.wait_ms
        let wake = null
        const touched = new Promise((resolve) => { wake = resolve })
        const off = link.onEvent(() => wake())
        try {
          while (rows.length === 0 && Date.now() < deadline) {
            const left = deadline - Date.now()
            if (left <= 0) break
            await Promise.race([touched, sleep(Math.min(left, 1000))])
            rows = link.events({ since, types, limit })
          }
        } finally {
          off()
        }
      }
      const lines = rows.map((r) => `#${r.seq} ${r.event}${r.data?.message ? `: ${short(r.data.message, 70)}` : ''}`)
      return {
        summary: rows.length ? `${rows.length} 条事件：${lines.join(' | ')}` : '没有新事件',
        data: { subscribed: types, since, events: rows },
      }
    },
  })

  const script = defineTool({
    name: 'sirius_script',
    description:
      '运行只读后台 JavaScript：export default async function(ctx)。run 立即返回 run_id；'
      + 'ctx.api.call 只读桥数据，ctx.events.subscribe 订阅事件，另有 sleep/log/checkpoint/signal。'
      + 'status/logs/stop/list 查询控制；脚本在独立 Worker 运行，超时会终止，不能访问文件/网络/进程或写动作。',
    parameters: obj({
      action: { type: 'string', enum: ['run', 'status', 'logs', 'stop', 'list'], description: '执行或管理后台脚本' },
      code: str('run 的脚本源码，必须 export default async function(ctx)，最多 64KiB'),
      args: { type: 'object', additionalProperties: true, description: '传给 ctx.args 的 JSON 参数' },
      run_id: str('status/logs/stop 的目标 run id'),
      timeout_ms: int('运行预算 100..300000ms，默认 30000'),
      wait_ms: int('run 后最多等待 0..2000ms；默认 0，立即返回'),
      since: int('logs 的起始序号（不含），默认 0'),
      limit: int('logs 最多返回条数，默认 50'),
    }, ['action']),
    timeoutMs: 10_000,
    run: async (args, exec) => {
      const runtime = sharedState.scripts
      if (!runtime) throw new Error('当前宿主没有配置脚本运行时')
      if (args.action === 'run') {
        const started = runtime.start({
          code: args.code,
          args: args.args ?? {},
          timeout_ms: args.timeout_ms,
          owner: exec?.agent?.id ?? '',
        })
        const data = await runtime.waitFor(started.run_id, Math.max(0, Math.min(2000, args.wait_ms ?? 0)))
        return { summary: `脚本 ${started.run_id} 已后台启动（当前 ${data.status}）；用 status/logs 查看，stop 停止`, data }
      }
      if (args.action === 'list') {
        const runs = runtime.list()
        return { summary: `脚本 ${runs.length} 个，其中活跃 ${runs.filter((run) => ['queued', 'running'].includes(run.status)).length} 个`, data: { runs } }
      }
      if (args.action === 'status') {
        const data = runtime.get(args.run_id)
        return { summary: `脚本 ${data.run_id}：${data.status}，日志 ${data.logs_count}，丢弃事件 ${data.dropped_events}`, data }
      }
      if (args.action === 'logs') {
        const data = runtime.logs(args.run_id, { since: args.since ?? 0, limit: args.limit ?? 50 })
        return { summary: `脚本 ${args.run_id}：${data.length} 条日志`, data: { logs: data, next_since: data.length ? data.at(-1).index + 1 : (args.since ?? 0) } }
      }
      if (args.action === 'stop') {
        const data = await runtime.stop(args.run_id)
        return { summary: `脚本 ${data.run_id} 已停止（${data.status}）；已发生的世界效果不作撤销假设`, data }
      }
      throw new Error(`未知脚本 action ${args.action}`)
    },
  })

  const plugin = defineTool({
    name: 'sirius_plugin',
    description:
      '管理动作插件：内置 core.* 可启停运行但不可改删；user.* 可创建、更新、启停和删除。'
      + 'once/task/service 生命周期，支持持续事件监听、后台动作、优先级抢占、通知与嵌套编排。'
      + 'config/validate/submit 读取、预检并应用当前会话工作区的 config/plugins.json 与 scripts/*.mjs；'
      + '只有身体所有者可提交挂载，未变服务不会重启。',
    parameters: obj({
      action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'enable', 'disable', 'run', 'status', 'logs', 'config', 'validate', 'submit'], description: '插件或会话配置管理操作' },
      id: str('插件 id：内置 core.* 或用户 user.*'),
      code: str('create/update 的脚本代码，export default async function(ctx)'),
      manifest: { type: 'object', additionalProperties: true, description: 'mode=once/task/service、priority、timeoutMs、persistent、maxRestarts、restartDelayMs、args' },
      args: { type: 'object', additionalProperties: true, description: '本次运行参数，与 manifest.args 合并；数字字段使用 JSON 数字（例如 5），不要使用字符串 "5"' },
      run_id: str('status/logs 的运行实例 id'),
      since: int('logs 起始序号（不含）'),
      limit: int('logs 最多条数'),
    }, ['action']),
    timeoutMs: 20_000,
    run: async (args, exec) => {
      const manager = sharedState.plugins
      if (!manager) throw new Error('当前宿主没有配置插件系统')
      const owner = exec?.agent?.id ?? ''
      const mutating = ['create', 'update', 'delete', 'enable', 'disable', 'run', 'submit']
      if (mutating.includes(args.action) && sharedState.canControl?.(owner) === false) {
        throw new Error('本会话未持有游戏身体，不能修改当前挂载；可编辑并 validate，sirius_init 后再 submit')
      }
      if (args.action === 'list') {
        const plugins = manager.list()
        return { summary: `插件 ${plugins.length} 个：内置 ${plugins.filter((p) => p.kind === 'core').length}，用户 ${plugins.filter((p) => p.kind === 'user').length}`, data: { plugins } }
      }
      if (args.action === 'get') return { summary: `插件 ${args.id}`, data: manager.get(args.id) }
      if (args.action === 'config' || args.action === 'validate') {
        const data = await manager.config({ owner, validate: args.action === 'validate' })
        return { summary: `会话配置 ${data.result}：${data.plugins ?? 0} 个插件，enabled ${data.enabled ?? 0} 个`, data }
      }
      if (args.action === 'submit') {
        const data = await manager.submit({ owner })
        return { summary: `配置已提交：变化 ${data.changes.length} 项，新启动 ${data.started.length} 个，停止 ${data.stopped.length} 个`, data }
      }
      if (args.action === 'create') {
        const id = String(args.id ?? '').startsWith('user.') ? args.id : `user.${args.id}`
        const data = await manager.create({ id, code: args.code, manifest: args.manifest }, { owner })
        return { summary: `已创建用户插件 ${id}，默认未启用`, data }
      }
      if (args.action === 'update') {
        const data = await manager.update(args.id, { code: args.code, manifest: args.manifest }, { owner })
        return { summary: `已更新 ${args.id} 到版本 ${data.version}，旧实例已停止`, data }
      }
      if (args.action === 'delete') return { summary: `已删除 ${args.id}`, data: await manager.delete(args.id, { owner }) }
      if (args.action === 'enable') {
        const data = await manager.enable(args.id, { owner })
        return { summary: `已启用 ${args.id}${data.run ? `（${data.run.run_id}）` : ''}`, data }
      }
      if (args.action === 'disable') return { summary: `已停用 ${args.id}`, data: await manager.disable(args.id, { owner }) }
      if (args.action === 'run') {
        const data = await manager.start(args.id, { args: args.args ?? {}, owner })
        return { summary: `插件 ${args.id} 已后台启动（${data.run_id}）`, data }
      }
      if (args.action === 'status') return { summary: `插件实例 ${args.run_id}`, data: manager.status(args.run_id) }
      if (args.action === 'logs') {
        const data = manager.logs(args.run_id, { since: args.since ?? 0, limit: args.limit ?? 50 })
        return { summary: `插件实例 ${args.run_id}：${data.length} 条日志`, data: { logs: data } }
      }
      throw new Error(`未知插件 action ${args.action}`)
    },
  })

  const bodyActions = new Set([
    'sirius_say', 'sirius_command', 'sirius_walk', 'sirius_tunnel', 'sirius_stop', 'sirius_follow', 'sirius_look',
    'sirius_dig', 'sirius_place', 'sirius_use', 'sirius_key', 'sirius_type', 'sirius_click',
    'sirius_select', 'sirius_use_item', 'sirius_use_entity', 'sirius_attack',
  ])
  const tools = [
    init, status, context, inventory, players, world, gui, screenshot, say, command, walk, tunnel, stop, follow, look,
    dig, place, use, events, key, type, click,
    // 1.6：背包选中 + 手里物品 + 实体交互 + Baritone/聊天取证
    select, useItem, useEntity, attack, baritone, chatHistory, script, plugin,
  ]
  return tools.map((tool) => {
    if (!bodyActions.has(tool.name)) return tool
    const execute = tool.execute
    return {
      ...tool,
      execute: async (args, exec) => {
        if (sharedState.canControl?.(exec?.agent?.id) === false) {
          throw new Error('本会话未持有游戏身体，动作未执行。先调用 sirius_init 独占并重置连接；sirius_status 可查看当前归属。')
        }
        return execute(args, exec)
      },
    }
  })
}

/** 工具名清单（plugin.mjs 用它做 restrict 与自检）。 */
export const TOOL_NAMES = [
  'sirius_init', 'sirius_status', 'sirius_context', 'sirius_inventory', 'sirius_players', 'sirius_world',
  'sirius_gui', 'sirius_screenshot', 'sirius_say', 'sirius_command', 'sirius_walk', 'sirius_tunnel', 'sirius_stop', 'sirius_follow',
  'sirius_look', 'sirius_dig', 'sirius_place', 'sirius_use', 'sirius_events',
  'sirius_key', 'sirius_type', 'sirius_click',
  // 1.6
  'sirius_select', 'sirius_use_item', 'sirius_use_entity', 'sirius_attack',
  'sirius_baritone', 'sirius_chat_history', 'sirius_script', 'sirius_plugin',
]
