/**
 * 配置与 token 发现。
 * ============================================================================
 * 设计要点：**零配置优先**。身体（sirius-bridge 模组）在游戏实例的
 * `config/sirius_bridge.toml` 里写 token，插件跑在同一台机器上，可以直接读它，
 * 用户不需要把 token 抄进 cordis.patch.yml。
 *
 * 现实教训（2026-10-31，首次真机接线）：启动器的"版本隔离"会让每个实例各有
 * 自己的 config 目录（PCL2 是 `<launcher>\.minecraft\versions\<name>\config\`），
 * 而 `%APPDATA%\.minecraft` 往往根本不存在 → 只认一个默认路径必然扑空。
 * 所以这里做两件事：
 *   1. 列出**所有**候选来源，交给连接层逐个试（bridge 用 1008 拒绝错的那个）；
 *   2. 一个 token 都没有时**不要**拿空 token 去撞握手——那会被误读成"token 不对"。
 *
 * 顺序（先命中先赢）：
 *   1. config.token               直接给明文 token
 *   2. config.tokenPath           指向 toml
 *   3. env SIRIUS_BRIDGE_CONFIG   指向 toml（便于 per-shell 覆盖）
 *   4. config.gameDir / env SIRIUS_GAME_DIR 下的 config/sirius_bridge.toml
 *   5. %APPDATA%\.minecraft\config\sirius_bridge.toml
 *   6. config.discoverDirs 里每个目录下的 config/sirius_bridge.toml
 *      （启动器实例，例如 <launcher>\.minecraft\versions\<name>\config\...）
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULTS = {
  url: 'ws://127.0.0.1:8765',
  token: '',
  tokenPath: '',
  gameDir: '',
  discoverDirs: [],
  /** 单次 RPC 的默认超时（毫秒）；动作类工具会自己传更长的值 */
  timeoutMs: 20_000,
  /** 人设文件路径（缺省 = 包根目录的 persona.txt）；换路径用这个 */
  personaFile: '',
  /** 内联人设（优先级最高，一般不用；改 persona.txt 更方便） */
  persona: '',
  /** 近聊尾巴：动作类工具返回时贴增量聊天（`enabled:false` 可关；`max` 是每次最多几条） */
  chatTail: { enabled: true, max: 3 },
  /** 截图只写入当前会话工作区的 images/，由官方 read_image 按需读取。 */
  screenshot: {},
}

/** 归一化配置：只接受认识字段，其余原样保留（前向兼容）。 */
export function normalizeConfig (raw = {}) {
  const out = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  out.url = String(out.url || DEFAULTS.url)
  out.timeoutMs = Number.isFinite(Number(out.timeoutMs)) && Number(out.timeoutMs) > 0
    ? Number(out.timeoutMs)
    : DEFAULTS.timeoutMs
  out.discoverDirs = Array.isArray(out.discoverDirs)
    ? out.discoverDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => resolve(d))
    : []
  return out
}

/**
 * 解析 sirius_bridge.toml 里我们关心的键。
 * 只做"够用"的 TOML：`key = value` 行、字符串/布尔/整数、整行或行尾 `#` 注释。
 * 不引入 TOML 库——这份文件是本项目自己写的，形状稳定（见 Sirius bridge README）。
 */
export function parseBridgeToml (text) {
  const out = {}
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][\w]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    // 去掉未加引号值后面的行尾注释（引号内不动）
    if (!value.startsWith('"')) {
      const hash = value.indexOf('#')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      out[key] = value.slice(1, -1)
    } else if (value === 'true' || value === 'false') {
      out[key] = value === 'true'
    } else if (/^-?\d+$/.test(value)) {
      out[key] = Number(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 一个 launch 目录下的 bridge 配置文件路径。 */
export function bridgeConfigIn (dir) {
  return join(dir, 'config', 'sirius_bridge.toml')
}

/** 按优先级列出候选配置文件（去重，绝不抛错）。 */
export function candidateTokenPaths (config, env = process.env) {
  const candidates = []
  const push = (p) => { if (p && typeof p === 'string' && p.trim()) candidates.push(resolve(p.trim())) }
  push(config.tokenPath)
  push(env.SIRIUS_BRIDGE_CONFIG)
  if (config.gameDir) push(bridgeConfigIn(resolve(config.gameDir)))
  if (env.SIRIUS_GAME_DIR) push(bridgeConfigIn(resolve(env.SIRIUS_GAME_DIR)))
  push(bridgeConfigIn(join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft')))
  for (const dir of config.discoverDirs) push(bridgeConfigIn(dir))
  return [...new Set(candidates)]
}

/**
 * 所有能读到的 token，按优先级去重。
 * 返回 `[{ token, port, path }]`；`path` 只用于诊断（告诉用户 token 来自哪）。
 * 同名 token 只保留第一次出现（先命中先赢）。
 */
export function findBridgeTokenCandidates (config, env = process.env) {
  const out = []
  const seenToken = new Set()
  const add = (token, path, port) => {
    if (typeof token !== 'string' || !token.trim()) return
    const value = token.trim()
    if (seenToken.has(value)) return
    seenToken.add(value)
    out.push({ token: value, path, port: Number(port) || undefined })
  }
  if (typeof config.token === 'string' && config.token.trim()) add(config.token, '(config.token)')
  for (const path of candidateTokenPaths(config, env)) {
    if (!existsSync(path)) continue
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const parsed = parseBridgeToml(text)
    add(parsed.token, path, parsed.port)
  }
  return out
}

/**
 * 第一个命中的凭据（兼容旧调用）。找不到时返回 `{ error, tried }`。
 */
export function findBridgeCredentials (config, env = process.env) {
  const candidates = findBridgeTokenCandidates(config, env)
  if (candidates.length > 0) {
    const first = candidates[0]
    return { token: first.token, port: first.port, path: first.path }
  }
  return {
    error:
      '找不到 sirius-bridge 的 token。请确认游戏已启动到标题屏，并给插件配置 gameDir 或 tokenPath，'
      + '或把游戏实例目录填进 discoverDirs（对应 <目录>/config/sirius_bridge.toml）。',
    tried: candidateTokenPaths(config, env),
  }
}
