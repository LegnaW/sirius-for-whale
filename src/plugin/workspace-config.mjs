import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { PluginRegistry } from './registry.mjs'
import { registerBuiltins } from './builtins.mjs'

const MAX_CONFIG_BYTES = 256 * 1024
const MAX_PLUGINS = 64

const CORE_ARG_KEYS = {
  'core.open_block': ['block', 'x', 'y', 'z', 'range', 'face', 'hand'],
  'core.damage_watch': ['damageCooldownMs', 'observeWindowMs', 'maxWakePerMinute', 'interruptTasks'],
  'core.input': ['key', 'click', 'duration_ms', 'modifiers'],
  'core.drop': ['slot', 'count'],
  'core.inventory_move': ['from_slot', 'to_slot', 'count'],
  'core.container_exchange': ['deposit', 'withdraw'],
  'core.screenshot': ['tier', 'bbox', 'quality'],
  'core.walk': ['x', 'y', 'z', 'tolerance', 'timeout_ms', 'open_doors'],
  'core.gather': ['x', 'y', 'z', 'range', 'max_blocks'],
  'core.dig_to': ['x', 'y', 'z', 'tolerance', 'timeout_ms', 'open_doors'],
  'core.follow': ['uuid', 'name', 'follow_radius', 'allow_break', 'allow_place'],
  'core.craft': ['grid', 'result', 'count', 'x', 'y', 'z', 'range'],
  'core.attack': ['uuid', 'name', 'radius', 'until', 'count', 'interval_ms', 'wait_cooldown', 'max_seconds', 'min_health'],
  'core.tunnel': ['height', 'width', 'depth', 'timeout_ms'],
}

const INTEGER_ARGS = {
  'core.gather': { max_blocks: [1, 32] },
  'core.damage_watch': { damageCooldownMs: [0, 300000], observeWindowMs: [0, 60000], maxWakePerMinute: [0, 100] },
  'core.drop': { slot: [0, 40], count: [1, 64] },
  'core.inventory_move': { from_slot: [0, 40], to_slot: [0, 40], count: [1, 128] },
  'core.follow': { follow_radius: [1, 64] },
  'core.craft': { count: [1, 64] },
  'core.attack': { count: [1, 10], interval_ms: [0, 5000] },
  'core.tunnel': { height: [2, 16], width: [1, 16], depth: [1, 256], timeout_ms: [5000, 300000] },
}

const BOOLEAN_ARGS = {
  'core.damage_watch': ['interruptTasks'],
  'core.walk': ['open_doors'],
  'core.dig_to': ['open_doors'],
  'core.follow': ['allow_break', 'allow_place'],
  'core.attack': ['wait_cooldown'],
}

function plainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys (value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} 含未知字段 ${key}`)
  }
}

function validateCoreArgs (id, args) {
  if (!plainObject(args)) throw new Error(`${id}.args 必须是对象`)
  assertKeys(args, CORE_ARG_KEYS[id] ?? [], `${id}.args`)
  if (id === 'core.gather' && args.range !== undefined && ![3, 5, 7].includes(args.range)) {
    throw new Error('core.gather.args.range 必须是 3、5 或 7')
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_ARGS[id] ?? {})) {
    if (args[key] === undefined) continue
    if (!Number.isInteger(args[key]) || args[key] < min || args[key] > max) {
      throw new Error(`${id}.args.${key} 必须是 ${min}..${max} 的整数`)
    }
  }
  for (const key of BOOLEAN_ARGS[id] ?? []) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw new Error(`${id}.args.${key} 必须是布尔值`)
    }
  }
}

function validateEnabled (definition) {
  if (!definition.enabled) return
  if (definition.manifest.mode !== 'service' || !definition.manifest.persistent) {
    throw new Error(`${definition.id} 只有 persistent service 可在配置中 enabled=true`)
  }
}

function configFromRegistry (registry) {
  const plugins = {}
  for (const definition of registry.list()) {
    const enabled = definition.manifest.mode === 'service' && definition.manifest.persistent
      ? definition.enabled : false
    if (definition.kind === 'core') {
      plugins[definition.id] = { enabled, args: { ...definition.manifest.args } }
    } else {
      const { args, ...manifest } = definition.manifest
      plugins[definition.id] = { enabled, manifest, args: { ...args } }
    }
  }
  return { version: 1, plugins }
}

async function atomicWrite (file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

async function readJson (file, maxBytes = MAX_CONFIG_BYTES) {
  const text = await readFile(file, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${file} 超过 ${maxBytes} 字节`)
  return JSON.parse(text)
}

export class WorkspaceConfig {
  constructor ({ workspace, damageWatch = {} }) {
    if (!workspace) throw new Error('缺少会话工作区')
    this.workspace = resolve(workspace)
    this.damageWatch = damageWatch
    this.scriptsDir = join(this.workspace, 'scripts')
    this.examplesDir = join(this.scriptsDir, 'example')
    this.configFile = join(this.workspace, 'config', 'plugins.json')
    this.runStateFile = join(this.workspace, 'state', 'runs.json')
    this.knownGoodFile = join(this.workspace, 'state', 'last-known-good.json')
  }

  createRegistry () {
    const registry = new PluginRegistry()
    registerBuiltins(registry, { damageWatch: this.damageWatch })
    return registry
  }

  async initialize () {
    await mkdir(this.scriptsDir, { recursive: true })
    await mkdir(dirname(this.configFile), { recursive: true })
    await mkdir(dirname(this.runStateFile), { recursive: true })
    try {
      await writeFile(this.configFile, `${JSON.stringify(configFromRegistry(this.createRegistry()), null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx',
      })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    return this.info()
  }

  async writeBuiltinExamples (registry) {
    await mkdir(this.examplesDir, { recursive: true })
    const plugins = []
    for (const definition of registry.list().filter((entry) => entry.kind === 'core')) {
      const file = `${definition.id}.mjs`
      const header = '// 系统内置插件参考副本；修改本文件不会生效，下次 sirius_init 会覆盖。\n'
      await atomicWrite(join(this.examplesDir, file), `${header}${definition.code}`)
      plugins.push({ id: definition.id, file, manifest: definition.manifest })
    }
    await atomicWrite(join(this.examplesDir, 'index.json'), `${JSON.stringify({
      version: 1, reference_only: true, plugins,
    }, null, 2)}\n`)
    return plugins.length
  }

  info (candidate = null) {
    return {
      workspace: this.workspace,
      scripts_dir: 'scripts',
      examples_dir: 'scripts/example',
      config_file: 'config/plugins.json',
      run_state_file: 'state/runs.json',
      revision: candidate?.revision ?? null,
      source: candidate?.source ?? null,
      degraded: candidate?.degraded === true,
      warning: candidate?.warning ?? null,
    }
  }

  async load ({ allowFallback = false } = {}) {
    await this.initialize()
    try {
      const config = await readJson(this.configFile)
      return await this.#build(config, null, 'workspace')
    } catch (error) {
      if (!allowFallback) throw new Error(`会话插件配置无效：${error.message}`)
      try {
        const stored = await readJson(this.knownGoodFile, 4 * 1024 * 1024)
        if (stored?.version !== 1 || !plainObject(stored.config) || !plainObject(stored.scripts)) {
          throw new Error('last-known-good 形状无效')
        }
        const candidate = await this.#build(stored.config, stored.scripts, 'last_known_good')
        candidate.degraded = true
        candidate.warning = `当前配置无效，已使用最后有效版本：${error.message}`
        return candidate
      } catch (fallbackError) {
        throw new Error(`会话插件配置无效：${error.message}；最后有效版本不可用：${fallbackError.message}`)
      }
    }
  }

  async #build (raw, scriptOverrides, source) {
    if (!plainObject(raw) || raw.version !== 1 || !plainObject(raw.plugins)) {
      throw new Error('配置必须包含 version:1 和 plugins 对象')
    }
    assertKeys(raw, ['version', 'plugins'], '配置')
    const entries = Object.entries(raw.plugins)
    if (entries.length > MAX_PLUGINS) throw new Error(`插件配置最多 ${MAX_PLUGINS} 项`)
    const registry = this.createRegistry()
    const coreIds = new Set(registry.list().filter((entry) => entry.kind === 'core').map((entry) => entry.id))
    const scripts = {}
    for (const [id, entry] of entries) {
      if (!plainObject(entry)) throw new Error(`${id} 配置必须是对象`)
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        throw new Error(`${id}.enabled 必须是布尔值`)
      }
      if (coreIds.has(id)) {
        assertKeys(entry, ['enabled', 'args'], id)
        validateCoreArgs(id, entry.args ?? {})
        registry.configureBuiltin(id, { args: entry.args ?? {}, enabled: entry.enabled === true })
        validateEnabled(registry.get(id))
        continue
      }
      if (!/^user\.[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`未知插件 ${id}`)
      assertKeys(entry, ['enabled', 'manifest', 'args'], id)
      if (entry.manifest !== undefined && !plainObject(entry.manifest)) throw new Error(`${id}.manifest 必须是对象`)
      if (entry.args !== undefined && !plainObject(entry.args)) throw new Error(`${id}.args 必须是对象`)
      const code = scriptOverrides ? scriptOverrides[id] : await this.#readScript(id)
      if (typeof code !== 'string') throw new Error(`${id} 缺少脚本`)
      const manifest = { ...(entry.manifest ?? {}), args: entry.args ?? entry.manifest?.args ?? {} }
      registry.createUser({ id, code, manifest })
      registry.setEnabled(id, entry.enabled === true)
      validateEnabled(registry.get(id))
      scripts[id] = code
    }
    const config = configFromRegistry(registry)
    const revision = createHash('sha256').update(JSON.stringify({ config, scripts })).digest('hex')
    return { registry, config, scripts, revision, source, degraded: false, warning: null }
  }

  async #readScript (id) {
    const root = await realpath(this.scriptsDir)
    const file = join(root, `${id.slice('user.'.length)}.mjs`)
    let canonical
    try {
      canonical = await realpath(file)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${id} 缺少 scripts/${id.slice('user.'.length)}.mjs`)
      throw error
    }
    const rel = relative(root, canonical)
    if (!rel || rel.startsWith('..') || resolve(root, rel) !== canonical) {
      throw new Error(`${id} 脚本必须位于当前会话 scripts 目录内`)
    }
    return readFile(canonical, 'utf8')
  }

  async saveKnownGood (candidate) {
    await atomicWrite(this.knownGoodFile, `${JSON.stringify({
      version: 1, config: candidate.config, scripts: candidate.scripts,
    }, null, 2)}\n`)
  }

  async syncRegistry (registry) {
    const config = configFromRegistry(registry)
    const scripts = {}
    for (const definition of registry.list().filter((entry) => entry.kind === 'user')) {
      scripts[definition.id] = definition.code
      await atomicWrite(join(this.scriptsDir, `${definition.id.slice('user.'.length)}.mjs`), definition.code)
    }
    await atomicWrite(this.configFile, `${JSON.stringify(config, null, 2)}\n`)
    const candidate = await this.#build(config, scripts, 'workspace')
    await this.saveKnownGood(candidate)
    return candidate
  }

  async removeScript (id) {
    if (!/^user\.[a-z][a-z0-9_-]{0,63}$/.test(id)) return
    try {
      await unlink(join(this.scriptsDir, `${id.slice('user.'.length)}.mjs`))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
