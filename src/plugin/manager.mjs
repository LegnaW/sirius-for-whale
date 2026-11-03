import { registerBuiltins } from './builtins.mjs'
import { captureScreenshot } from './screenshot.mjs'
import { PluginRunStore } from './run-store.mjs'

const ACTIVE = new Set(['queued', 'running'])

export class PluginManager {
  #restartTimers = new Map()
  #restartCounts = new Map()
  #lastNotifications = new Map()

  constructor ({ registry, runtime, scheduler, notify = () => {}, log = () => {}, workspace = null, damageWatch = {}, runStateFile = '' }) {
    this.registry = registry
    this.runtime = runtime
    this.scheduler = scheduler
    this.deliver = notify
    this.workspace = workspace
    this.log = log
    this.runStore = new PluginRunStore(runStateFile)
    this.runtime.pluginHost = this
    this.runtime.onFinal = (record) => this.#onFinal(record)
    this.runtime.onCheckpoint = (record, value) => this.runStore.checkpoint(record, value)
    registerBuiltins(this.registry, { damageWatch })
  }

  mount ({ registry, runStateFile = '' }) {
    const active = this.runtime.list().some((run) => run.plugin_id && ACTIVE.has(run.status))
    if (active) throw new Error('仍有活跃插件，不能切换会话配置')
    for (const id of [...this.#restartTimers.keys()]) this.#clearRestart(id)
    this.#lastNotifications.clear()
    this.registry = registry
    this.runStore = new PluginRunStore(runStateFile)
  }

  list () {
    return this.registry.list().map((definition) => ({
      ...definition,
      code: undefined,
      active: this.runtime.list().filter((run) => run.plugin_id === definition.id && ACTIVE.has(run.status)),
    }))
  }

  get (id) {
    return this.list().find((plugin) => plugin.id === id) ?? this.registry.get(id)
  }

  create (input) { return this.registry.createUser(input) }

  async restore ({ owner = '' } = {}) {
    const previous = this.runStore.restoreActive()
    const pending = new Map(previous.map((run) => [run.plugin_id, run]))
    const runs = []
    const resume = (run) => run ? {
      ...run.args,
      resume_checkpoint: run.checkpoint,
      resume_from: run.run_id,
    } : {}
    for (const plugin of this.registry.list().filter((entry) => entry.enabled)) {
      const old = pending.get(plugin.id)
      pending.delete(plugin.id)
      runs.push(await this.start(plugin.id, { owner: old?.owner ?? owner, args: resume(old) }))
    }
    for (const old of pending.values()) {
      if (old.mode !== 'task' || !this.registry.list().some((plugin) => plugin.id === old.plugin_id)) continue
      runs.push(await this.start(old.plugin_id, { owner: old.owner, args: resume(old) }))
    }
    return runs
  }

  async update (id, input) {
    await this.#stopInstances(id, 'plugin_updated')
    this.runStore.invalidatePlugin(id, 'plugin_updated')
    return this.registry.updateUser(id, input)
  }

  async delete (id) {
    await this.#stopInstances(id, 'plugin_deleted')
    this.runStore.invalidatePlugin(id, 'plugin_deleted')
    const definition = this.registry.deleteUser(id)
    return { deleted: true, id: definition.id }
  }

  async enable (id, { owner = '' } = {}) {
    const definition = this.registry.setEnabled(id, true)
    const active = this.runtime.list().find((run) => run.plugin_id === id && ACTIVE.has(run.status))
    if (active) return { definition, run: active }
    const run = await this.start(id, { owner })
    return { definition, run }
  }

  async disable (id) {
    this.#clearRestart(id)
    const definition = this.registry.setEnabled(id, false)
    await this.#stopInstances(id, 'plugin_disabled')
    return { definition }
  }

  async start (id, { args = {}, owner = '', parentId = null } = {}) {
    const definition = this.registry.get(id)
    const parent = parentId ? this.runtime.get(parentId) : null
    const stack = [...(parent?.plugin_stack ?? []), id]
    if ((parent?.plugin_stack ?? []).includes(id)) throw new Error(`检测到循环插件调用：${stack.join(' → ')}`)
    if (stack.length > 8) throw new Error(`插件调用深度超过 8：${stack.join(' → ')}`)
    const duplicate = this.runtime.list().find((run) => run.plugin_id === id && ACTIVE.has(run.status))
    if (duplicate) return duplicate
    const priority = Math.min(parent?.priority ?? 100, definition.manifest.priority)
    const mergedArgs = { ...definition.manifest.args, ...args }
    const run = this.runtime.start({
      code: definition.code,
      args: mergedArgs,
      timeout_ms: definition.manifest.timeoutMs,
      owner,
      allowWrite: true,
      pluginId: id,
      priority,
      parentId,
      rootId: parent?.root_id ?? parent?.run_id ?? null,
      pluginStack: stack,
      mode: definition.manifest.mode,
    })
    this.runStore.start(run, mergedArgs)
    return run
  }

  async stop (id, { parentId = null } = {}) {
    const parent = parentId ? this.runtime.get(parentId) : null
    const runs = this.runtime.list().filter((run) => run.plugin_id === id && ACTIVE.has(run.status))
    if (parent) {
      const illegal = runs.some((run) => run.root_id !== parent.root_id)
      if (illegal) throw new Error('插件只能停止同一调用树中的子插件')
    }
    this.#clearRestart(id)
    await this.registry.setEnabled(id, false)
    return Promise.all(runs.map((run) => this.runtime.stop(run.run_id, 'plugin_stopped')))
  }

  async interrupt (record, { mode = null } = {}) {
    const runs = this.runtime.list().filter((run) => ACTIVE.has(run.status)
      && run.plugin_id && run.plugin_id !== record.pluginId && run.priority < record.priority
      && (!mode || run.mode === mode))
    await Promise.all(runs.map((run) => this.runtime.stop(run.run_id, 'preempted')))
    return runs.map((run) => run.run_id)
  }

  wait (runId, waitMs = 300_000) { return this.runtime.waitFor(runId, waitMs) }
  status (runId) { return this.runtime.get(runId) }
  logs (runId, options) { return this.runtime.logs(runId, options) }

  async notify (record, text) {
    if (this.runtime.canControl(record.owner) === false) return { delivered: false, reason: 'owner_changed' }
    const message = String(text ?? '').trim().slice(0, 2000)
    if (!message) return { delivered: false, reason: 'empty' }
    const now = Date.now()
    const previous = this.#lastNotifications.get(record.pluginId)
    if (previous && previous.text === message && now - previous.at < 1000) return { delivered: false, reason: 'duplicate' }
    this.#lastNotifications.set(record.pluginId, { text: message, at: now })
    await this.deliver(`〔插件·${record.pluginId}〕\n${message}`)
    return { delivered: true }
  }

  async screenshot (record, params) {
    if (this.runtime.canControl(record.owner) === false) throw new Error('身体所有权已变更，截图未保存')
    const workspace = this.workspace?.(record.owner)
    return captureScreenshot({ link: this.runtime.link, workspace, params })
  }

  snapshot () {
    return {
      definitions: this.registry.list().length,
      enabled: this.registry.list().filter((plugin) => plugin.enabled).length,
      restarting: this.#restartTimers.size,
      scheduler: this.scheduler.snapshot(),
    }
  }

  async dispose () {
    for (const id of this.#restartTimers.keys()) this.#clearRestart(id)
  }

  async #stopInstances (id, reason) {
    this.#clearRestart(id)
    const runs = this.runtime.list().filter((run) => run.plugin_id === id && ACTIVE.has(run.status))
    await Promise.all(runs.map((run) => this.runtime.stop(run.run_id, reason)))
  }

  #clearRestart (id) {
    clearTimeout(this.#restartTimers.get(id))
    this.#restartTimers.delete(id)
    this.#restartCounts.delete(id)
  }

  async #onFinal (record) {
    if (!record.plugin_id || record.error === 'plugin_unloaded') return
    this.runStore.finish(record)
    const children = this.runtime.list().filter((run) => run.parent_id === record.run_id && ACTIVE.has(run.status))
    await Promise.all(children.map((run) => this.runtime.stop(run.run_id, 'parent_finished')))
    const definition = this.registry.list().find((plugin) => plugin.id === record.plugin_id)
    if (!definition) return
    if (definition.manifest.mode !== 'service') {
      if (definition.enabled) this.registry.setEnabled(definition.id, false)
      return
    }
    if (!definition.enabled || !definition.manifest.persistent) {
      if (definition.enabled) this.registry.setEnabled(definition.id, false)
      return
    }
    if (!['failed', 'timed_out'].includes(record.status)) return
    const count = (this.#restartCounts.get(definition.id) ?? 0) + 1
    if (count > definition.manifest.maxRestarts) {
      this.registry.setEnabled(definition.id, false)
      this.#restartCounts.delete(definition.id)
      this.log(`插件 ${definition.id} 超过最大重启次数，已停用`)
      return
    }
    this.#restartCounts.set(definition.id, count)
    const delay = definition.manifest.restartDelayMs * (2 ** (count - 1))
    const timer = setTimeout(() => {
      this.#restartTimers.delete(definition.id)
      this.start(definition.id, {
        owner: record.owner,
        args: { resume_checkpoint: record.checkpoint, resume_from: record.run_id },
      }).catch((error) => this.log(`插件 ${definition.id} 重启失败：${error.message}`))
    }, delay)
    this.#restartTimers.set(definition.id, timer)
  }
}
