import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const MODES = new Set(['once', 'task', 'service'])

function normalizeManifest (raw = {}, { builtin = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest 必须是对象')
  const mode = raw.mode ?? 'once'
  if (!MODES.has(mode)) throw new Error('manifest.mode 必须是 once/task/service')
  const priority = raw.priority ?? 50
  const cap = builtin ? 90 : 80
  if (!Number.isInteger(priority) || priority < 1 || priority > cap) throw new Error(`priority 必须是 1..${cap}`)
  const timeoutMs = raw.timeoutMs ?? (mode === 'service' ? 0 : 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('timeoutMs 必须是 0..300000，0 表示不限时')
  return {
    mode,
    priority,
    timeoutMs,
    persistent: mode === 'service' && raw.persistent === true,
    maxRestarts: Number.isInteger(raw.maxRestarts) ? Math.max(0, Math.min(20, raw.maxRestarts)) : 3,
    restartDelayMs: Number.isInteger(raw.restartDelayMs) ? Math.max(50, Math.min(60_000, raw.restartDelayMs)) : 500,
    description: String(raw.description ?? '').slice(0, 500),
    args: raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {},
  }
}

function validateCode (code) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('插件 code 不能为空')
  if (Buffer.byteLength(code, 'utf8') > 64 * 1024) throw new Error('插件 code 不能超过 64KiB')
  if (!/\bexport\s+default\s+/.test(code)) throw new Error('插件必须 export default async function(ctx)')
  return code
}

function normalizeId (id, builtin) {
  const value = String(id ?? '')
  if (!/^(?:core|user)\.[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error('插件 id 必须匹配 core.* 或 user.*')
  if (builtin !== value.startsWith('core.')) throw new Error(builtin ? '内置插件必须使用 core.*' : '用户插件必须使用 user.*')
  return value
}

export class PluginRegistry {
  #definitions = new Map()

  constructor ({ storageFile = '' } = {}) {
    this.storageFile = storageFile ? resolve(storageFile) : ''
    if (!this.storageFile) return
    try {
      const stored = JSON.parse(readFileSync(this.storageFile, 'utf8'))
      for (const definition of stored.plugins ?? []) {
        if (!String(definition.id).startsWith('user.')) continue
        const id = normalizeId(definition.id, false)
        this.#definitions.set(id, {
          id,
          kind: 'user',
          code: validateCode(definition.code),
          manifest: normalizeManifest(definition.manifest),
          enabled: definition.enabled === true,
          version: definition.version ?? 1,
        })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`插件存储无法读取：${error.message}`)
    }
  }

  registerBuiltin ({ id, code, manifest, enabled = false }) {
    const normalizedId = normalizeId(id, true)
    if (this.#definitions.has(normalizedId)) throw new Error(`插件 ${normalizedId} 已存在`)
    const definition = {
      id: normalizedId,
      kind: 'core',
      code: validateCode(code),
      manifest: normalizeManifest(manifest, { builtin: true }),
      enabled: enabled === true,
      version: 1,
    }
    this.#definitions.set(normalizedId, definition)
    return this.public(definition)
  }

  configureBuiltin (id, { args, enabled } = {}) {
    const definition = this.#require(id)
    if (definition.kind !== 'core') throw new Error('只有内置插件使用该配置接口')
    if (args !== undefined) {
      definition.manifest = { ...definition.manifest, args: { ...args } }
    }
    if (enabled !== undefined) definition.enabled = enabled === true
    return this.public(definition)
  }

  createUser ({ id, code, manifest }) {
    const normalizedId = normalizeId(id, false)
    if (this.#definitions.has(normalizedId)) throw new Error(`插件 ${normalizedId} 已存在`)
    const definition = {
      id: normalizedId,
      kind: 'user',
      code: validateCode(code),
      manifest: normalizeManifest(manifest),
      enabled: false,
      version: 1,
    }
    this.#definitions.set(normalizedId, definition)
    this.#persist()
    return this.public(definition)
  }

  updateUser (id, { code, manifest }) {
    const definition = this.#require(id)
    if (definition.kind !== 'user') throw new Error('内置插件不可修改')
    definition.code = code === undefined ? definition.code : validateCode(code)
    definition.manifest = manifest === undefined
      ? definition.manifest
      : normalizeManifest({ ...definition.manifest, ...manifest })
    definition.version += 1
    this.#persist()
    return this.public(definition)
  }

  deleteUser (id) {
    const definition = this.#require(id)
    if (definition.kind !== 'user') throw new Error('内置插件不可删除')
    this.#definitions.delete(id)
    this.#persist()
    return definition
  }

  setEnabled (id, enabled) {
    const definition = this.#require(id)
    definition.enabled = enabled === true
    this.#persist()
    return this.public(definition)
  }

  get (id) { return this.public(this.#require(id)) }
  list () { return [...this.#definitions.values()].map((definition) => this.public(definition)) }

  #require (id) {
    const definition = this.#definitions.get(id)
    if (!definition) throw new Error(`插件 ${id} 不存在`)
    return definition
  }

  public (definition) {
    return {
      id: definition.id,
      kind: definition.kind,
      code: definition.code,
      manifest: { ...definition.manifest, args: { ...definition.manifest.args } },
      enabled: definition.enabled,
      version: definition.version,
    }
  }

  #persist () {
    if (!this.storageFile) return
    mkdirSync(dirname(this.storageFile), { recursive: true })
    const temporary = `${this.storageFile}.tmp`
    const plugins = this.list().filter((definition) => definition.kind === 'user')
    writeFileSync(temporary, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    renameSync(temporary, this.storageFile)
  }
}
