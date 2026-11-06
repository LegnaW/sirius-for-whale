import { PluginManager } from './manager.mjs'
import { WorkspaceConfig } from './workspace-config.mjs'

const ACTIVE = new Set(['queued', 'running'])

function definitionShape (definition) {
  return JSON.stringify({ code: definition.code, manifest: definition.manifest })
}

export class SessionPluginManager {
  #prepared = new Map()
  #submitQueue = Promise.resolve()

  constructor (options) {
    this.manager = new PluginManager(options)
    this.runtime = this.manager.runtime
    this.scheduler = this.manager.scheduler
    this.workspace = options.workspace
    this.ownerRoot = options.ownerRoot ?? ((owner) => owner)
    this.damageWatch = options.damageWatch ?? {}
    this.activeOwner = ''
    this.activeProfile = null
    this.activation = null
  }

  get registry () { return this.manager.registry }

  #root (owner) { return this.ownerRoot(owner) ?? owner }

  list () { return this.manager.list() }
  get (id) { return this.manager.get(id) }
  wait (runId, waitMs) { return this.manager.wait(runId, waitMs) }
  status (runId) { return this.manager.status(runId) }
  logs (runId, options) { return this.manager.logs(runId, options) }
  snapshot () { return this.manager.snapshot() }
  notify (record, text) { return this.manager.notify(record, text) }
  screenshot (record, params) { return this.manager.screenshot(record, params) }
  interrupt (record, options) { return this.manager.interrupt(record, options) }

  activationInfo () { return this.activation }

  async #profile (owner) {
    const workspace = await this.workspace?.(this.#root(owner))
    if (!workspace) return null
    const config = new WorkspaceConfig({ workspace, damageWatch: this.damageWatch })
    return { config, workspace }
  }

  async prepare ({ owner = '' } = {}) {
    const profile = await this.#profile(owner)
    if (!profile) return { result: 'legacy_workspace' }
    const candidate = await profile.config.load({ allowFallback: true })
    await profile.config.writeBuiltinExamples(candidate.registry)
    const prepared = { ...profile, candidate, owner }
    this.#prepared.set(owner, prepared)
    return this.activationInfoFor(prepared)
  }

  activationInfoFor (profile) {
    return {
      owner: profile.owner,
      ...profile.config.info(profile.candidate),
      plugins: profile.candidate.registry.list().length,
      enabled: profile.candidate.registry.list().filter((entry) => entry.enabled).length,
    }
  }

  async restore ({ owner = '' } = {}) {
    let profile = this.#prepared.get(owner)
    if (!profile) {
      const workspace = await this.workspace?.(this.#root(owner))
      if (!workspace) {
        this.activeOwner = ''
        this.activeProfile = null
        this.activation = null
        return this.manager.restore({ owner })
      }
      await this.prepare({ owner })
      profile = this.#prepared.get(owner)
    }
    this.#prepared.delete(owner)
    this.manager.mount({ registry: profile.candidate.registry, runStateFile: profile.config.runStateFile })
    this.activeOwner = owner
    this.activeProfile = profile
    this.activation = this.activationInfoFor(profile)
    const runs = await this.manager.restore({ owner })
    await profile.config.saveKnownGood(profile.candidate)
    return runs
  }

  #assertOwner (owner) {
    if (this.activeProfile && this.#root(owner) !== this.activeOwner) {
      throw new Error('本会话未持有游戏身体，不能修改当前挂载；可先编辑并 validate，init 后再 submit')
    }
  }

  async config ({ owner = '', validate = false } = {}) {
    const profile = await this.#profile(owner)
    if (!profile) return { result: 'legacy_workspace' }
    const candidate = await profile.config.load({ allowFallback: !validate })
    return {
      result: validate ? 'valid' : 'loaded',
      ...profile.config.info(candidate),
      config: candidate.config,
      plugins: candidate.registry.list().length,
      enabled: candidate.registry.list().filter((entry) => entry.enabled).length,
    }
  }

  submit ({ owner = '' } = {}) {
    this.#assertOwner(owner)
    const operation = async () => {
      if (!this.activeProfile) throw new Error('当前会话尚未通过 sirius_init 挂载工作区配置')
      const { config } = this.activeProfile
      const candidate = await config.load()
      const previousRegistry = this.manager.registry
      const previous = new Map(previousRegistry.list().map((entry) => [entry.id, entry]))
      const next = new Map(candidate.registry.list().map((entry) => [entry.id, entry]))
      const stopped = []
      const invalidated = []
      const changes = []
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        const before = previous.get(id)
        const after = next.get(id)
        const active = this.runtime.list().some((run) => run.plugin_id === id && ACTIVE.has(run.status))
        const removed = before && !after
        const changed = before && after && definitionShape(before) !== definitionShape(after)
        const enabledChanged = before && after && before.enabled !== after.enabled
        const disabledService = after && !after.enabled && after.manifest.mode === 'service' && active
        if (!removed && !changed && !disabledService && !enabledChanged) continue
        changes.push({
          id,
          change: removed ? 'removed' : changed ? 'updated' : after?.enabled ? 'enabled' : 'disabled',
        })
        if (removed || changed || disabledService) {
          await this.manager.stop(id)
          stopped.push(id)
        }
        if (removed || changed) {
          this.manager.runStore.invalidatePlugin(id, 'config_updated')
          invalidated.push(id)
        }
      }
      try {
        this.manager.registry = candidate.registry
        const started = []
        for (const definition of candidate.registry.list().filter((entry) => entry.enabled)) {
          const active = this.runtime.list().some((run) => run.plugin_id === definition.id && ACTIVE.has(run.status))
          if (!active) started.push(await this.manager.start(definition.id, { owner: this.activeOwner }))
        }
        this.activeProfile.candidate = candidate
        this.activation = this.activationInfoFor(this.activeProfile)
        await config.saveKnownGood(candidate)
        return {
          result: 'submitted', revision: candidate.revision, changed: changes.length > 0,
          changes, stopped, invalidated, started,
          ...config.info(candidate),
        }
      } catch (error) {
        this.manager.registry = previousRegistry
        for (const definition of previousRegistry.list().filter((entry) => entry.enabled)) {
          const active = this.runtime.list().some((run) => run.plugin_id === definition.id && ACTIVE.has(run.status))
          if (!active) await this.manager.start(definition.id, { owner: this.activeOwner }).catch(() => {})
        }
        throw new Error(`配置应用失败，已尝试恢复旧挂载：${error.message}`)
      }
    }
    const pending = this.#submitQueue.then(operation, operation)
    this.#submitQueue = pending.catch(() => {})
    return pending
  }

  async #syncActive () {
    if (!this.activeProfile) return
    const candidate = await this.activeProfile.config.syncRegistry(this.manager.registry)
    this.activeProfile.candidate = candidate
    this.activation = this.activationInfoFor(this.activeProfile)
  }

  create (input, { owner = '' } = {}) {
    this.#assertOwner(owner)
    const definition = this.manager.create(input)
    return this.#syncActive().then(() => definition)
  }

  async update (id, input, { owner = '' } = {}) {
    this.#assertOwner(owner)
    const definition = await this.manager.update(id, input)
    await this.#syncActive()
    return definition
  }

  async delete (id, { owner = '' } = {}) {
    this.#assertOwner(owner)
    const result = await this.manager.delete(id)
    await this.activeProfile?.config.removeScript(id)
    await this.#syncActive()
    return result
  }

  async enable (id, { owner = '' } = {}) {
    this.#assertOwner(owner)
    const result = await this.manager.enable(id, { owner: owner || this.activeOwner })
    if (result.definition.manifest.mode === 'service' && result.definition.manifest.persistent) {
      await this.#syncActive()
    }
    return result
  }

  async disable (id, { owner = '' } = {}) {
    this.#assertOwner(owner)
    const definition = this.manager.get(id)
    const result = await this.manager.disable(id)
    if (definition.manifest.mode === 'service' && definition.manifest.persistent) await this.#syncActive()
    return result
  }

  async start (id, options = {}) {
    this.#assertOwner(options.owner ?? '')
    return this.manager.start(id, options)
  }

  async stop (id, options = {}) {
    this.#assertOwner(options.owner ?? this.activeOwner)
    const definition = this.manager.get(id)
    const result = await this.manager.stop(id, options)
    if (definition.manifest.mode === 'service' && definition.manifest.persistent) await this.#syncActive()
    return result
  }

  async dispose () {
    this.#prepared.clear()
    await this.manager.dispose()
  }
}
