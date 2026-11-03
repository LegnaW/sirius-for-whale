export const ACTION_RESOURCES = {
  dig: ['world_edit'],
  place: ['world_edit'],
  use: ['interaction'],
  useItem: ['interaction'],
  'entity.use': ['interaction'],
  'entity.attack': ['combat'],
  'inventory.select': ['inventory'],
  'inventory.drop': ['inventory'],
  'container.clickSlot': ['inventory'],
  'container.transfer': ['inventory'],
  'container.close': ['inventory'],
  'input.key': ['interaction'],
  'input.mouseMove': ['interaction'],
  'input.click': ['interaction'],
  'baritone.goto': ['movement'],
  'baritone.follow': ['movement'],
  'baritone.settings': ['movement'],
  'baritone.tunnel': ['movement', 'world_edit'],
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
    if (method === 'baritone.stop') return []
    if (['baritone.goto', 'baritone.follow'].includes(method) && params.allow_break === true) {
      return ['movement', 'world_edit']
    }
    return ACTION_RESOURCES[method] ?? null
  }

  async acquire (record, method, signal, params = {}) {
    const resources = this.resourcesFor(method, params)
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
        await this.runtime.link.call('baritone.stop', {}).catch((error) => this.runtime.log(`抢占停止移动失败：${error.message}`))
        await this.runtime.link.call('baritone.settings', { allow_break: false, allow_place: false })
          .catch((error) => this.runtime.log(`抢占恢复移动设置失败：${error.message}`))
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
