import { engageId } from './engage.mjs'
import { gatherId } from './gather.mjs'

export const ACTION_RESOURCES = {
  dig: ['world_edit', 'view'],
  look: ['view'],
  lookAt: ['view'],
  'input.text': ['interaction'],
  'chat.send': ['communication'],
  place: ['world_edit', 'view'],
  use: ['interaction', 'view'],
  useItem: ['interaction', 'view'],
  'entity.use': ['interaction', 'view'],
  'entity.attack': ['combat', 'view'],
  'inventory.select': ['inventory'],
  'inventory.drop': ['inventory'],
  'container.clickSlot': ['inventory'],
  'container.transfer': ['inventory'],
  'container.close': ['inventory'],
  'input.key': ['interaction', 'movement', 'view'],
  'input.mouseMove': ['interaction', 'view'],
  'input.click': ['interaction', 'view'],
  'baritone.goto': ['movement', 'view'],
  'baritone.follow': ['movement', 'view'],
  'baritone.settings': ['movement', 'world_edit', 'view'],
  'baritone.stop': ['movement', 'view'],
  'baritone.tunnel': ['movement', 'world_edit', 'view'],
}

export class ActionScheduler {
  #leases = new Map()
  #byRun = new Map()
  #pending = []
  #sequence = 0

  bindRuntime (runtime) {
    this.runtime = runtime
  }

  resourcesFor (method, params = {}) {
    if (method === 'dig' && params.auto_tool === true) return ['world_edit', 'view', 'inventory']
    if (method === 'chat.send' && String(params.string ?? '').trimStart().startsWith('#')) {
      return ['communication', 'movement', 'world_edit', 'view']
    }
    if (['baritone.goto', 'baritone.follow'].includes(method) && (params.allow_break === true || params.allow_place === true)) {
      return ['movement', 'world_edit', 'view']
    }
    return ACTION_RESOURCES[method] ?? null
  }

  async acquire (record, method, signal, params = {}) {
    const resources = record.pluginId === engageId && method === 'getStats'
      ? ['movement', 'combat', 'view']
      : record.pluginId === gatherId && method === 'getStats'
        ? ['movement', 'world_edit', 'inventory', 'view']
        : this.resourcesFor(method, params)
    if (!resources) throw new Error(`插件不允许调用 ${method}`)
    if (resources.length === 0) return []
    for (;;) {
      if (signal?.aborted) throw new Error('动作等待已取消')
      const conflicts = new Set(resources.map((resource) => this.#leases.get(resource)).filter((id) => id && id !== record.id))
      if (conflicts.size === 0) {
        for (const resource of resources) this.#leases.set(resource, record.id)
        this.#byRun.set(record.id, new Set([...(this.#byRun.get(record.id) ?? []), ...resources]))
        return resources
      }
      const priorities = [...conflicts].map((id) => this.runtime.get(id).priority ?? 0)
      if (priorities.every((priority) => record.priority > priority)) {
        await Promise.all([...conflicts].map((id) => this.runtime.stop(id, 'preempted')))
        continue
      }
      await this.#wait(record, signal)
    }
  }

  release (runId) {
    for (const [resource, owner] of this.#leases) {
      if (owner === runId) this.#leases.delete(resource)
    }
    this.#byRun.delete(runId)
    for (const entry of [...this.#pending]) {
      if (entry.record.id === runId) {
        this.#remove(entry)
        entry.reject(new Error('插件已停止，动作等待取消'))
      }
    }
    this.#wake()
  }

  snapshot () {
    return {
      leases: Object.fromEntries(this.#leases),
      pending: this.#pending.map((entry) => ({ run_id: entry.record.id, priority: entry.record.priority })),
    }
  }

  #wait (record, signal) {
    return new Promise((resolve, reject) => {
      const entry = { record, resolve, reject, sequence: ++this.#sequence, aborted: null }
      if (signal) {
        entry.aborted = () => {
          this.#remove(entry)
          reject(new Error('动作等待已取消'))
        }
        signal.addEventListener('abort', entry.aborted, { once: true })
      }
      entry.cleanup = () => signal?.removeEventListener('abort', entry.aborted)
      this.#pending.push(entry)
    })
  }

  #remove (entry) {
    const index = this.#pending.indexOf(entry)
    if (index >= 0) this.#pending.splice(index, 1)
    entry.cleanup?.()
  }

  #wake () {
    const pending = [...this.#pending].sort((a, b) => b.record.priority - a.record.priority || a.sequence - b.sequence)
    for (const entry of pending) {
      this.#remove(entry)
      entry.resolve()
    }
  }
}
