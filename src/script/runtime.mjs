import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { toLosslessJSON } from '../json.mjs'
import { inventoryPluginIds } from '../plugin/inventory.mjs'
import { activeStatus, eventMatches, normalizeEventFilter, READ_METHODS, validateScriptInput } from './contracts.mjs'

const textOf = (value) => {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

export class ScriptRuntime {
  #runs = new Map()
  #offEvent
  #sequence = 0
  #disposed = false

  constructor ({ link, canControl, log = () => {}, config = {}, scheduler = null }) {
    this.link = link
    this.canControl = typeof canControl === 'function' ? canControl : () => true
    this.log = log
    this.scheduler = scheduler
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000,
      maxTimeoutMs: config.maxTimeoutMs ?? 300_000,
      maxCodeBytes: config.maxCodeBytes ?? 64 * 1024,
      rpcTimeoutMs: config.rpcTimeoutMs ?? 6_000,
      maxActiveRuns: config.maxActiveRuns ?? 16,
      eventQueueSize: config.eventQueueSize ?? 100,
      maxLogs: config.maxLogs ?? 200,
      maxLogChars: config.maxLogChars ?? 4_000,
      historySize: config.historySize ?? 100,
    }
    this.#offEvent = link.onEvent((record) => this.#dispatch(record))
  }

  start ({ code, args = {}, timeout_ms: timeoutMs, owner, allowWrite = false,
    pluginId = null, priority = 0, parentId = null, rootId = null, pluginStack = [], mode = 'task' }) {
    if (this.#disposed) throw new Error('脚本运行时已卸载')
    if ([...this.#runs.values()].filter(activeStatus).length >= this.config.maxActiveRuns) {
      throw new Error(`活跃脚本已达到 ${this.config.maxActiveRuns} 个，请先停止不需要的 run`)
    }
    const input = validateScriptInput({
      code,
      args,
      timeoutMs: timeoutMs ?? this.config.defaultTimeoutMs,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      maxTimeoutMs: this.config.maxTimeoutMs,
      maxCodeBytes: this.config.maxCodeBytes,
    })
    const id = `run_${Date.now().toString(36)}_${++this.#sequence}_${randomUUID().slice(0, 8)}`
    const record = {
      id,
      owner: String(owner ?? ''),
      status: 'queued',
      outcome: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      deadline: input.timeoutMs,
      result: undefined,
      error: null,
      logs: [],
      logSequence: 0,
      droppedCount: 0,
      checkpoint: undefined,
      subscriptions: new Map(),
      waiters: new Set(),
      controller: new AbortController(),
      worker: null,
      timer: null,
      allowWrite,
      pluginId,
      priority,
      parentId,
      rootId: rootId ?? id,
      pluginStack,
      mode,
    }
    this.#runs.set(id, record)
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { runId: id, code: input.code, args: toLosslessJSON(input.args) },
    })
    record.worker = worker
    worker.on('online', () => {
      if (!activeStatus(record)) return
      record.status = 'running'
      record.startedAt = Date.now()
      if (input.timeoutMs > 0) {
        record.timer = setTimeout(() => {
          this.stop(id, 'deadline_exceeded').catch(() => {})
        }, input.timeoutMs)
      }
    })
    worker.on('message', (frame) => this.#onMessage(record, frame))
    worker.on('error', (error) => this.#finish(record, 'failed', { error: textOf(error) }))
    worker.on('exit', (code) => {
      if (activeStatus(record)) this.#finish(record, 'failed', { error: `Worker 未返回结果便退出（code ${code}）` })
    })
    return this.publicRun(record)
  }

  get (id) {
    const record = this.#runs.get(id)
    if (!record) throw new Error(`找不到 ${id}`)
    return this.publicRun(record)
  }

  list () { return [...this.#runs.values()].map((record) => this.publicRun(record)) }

  logs (id, { since = 0, limit = 50 } = {}) {
    const record = this.#runs.get(id)
    if (!record) throw new Error(`找不到 ${id}`)
    return record.logs.filter((entry) => entry.index >= since).slice(-Math.max(1, Math.min(200, limit)))
  }

  async waitFor (id, waitMs = 0) {
    const record = this.#runs.get(id)
    if (!record) throw new Error(`找不到 ${id}`)
    const deadline = Date.now() + waitMs
    while (activeStatus(record) && Date.now() < deadline) {
      await new Promise((resolve) => {
        const waiter = () => {
          clearTimeout(timer)
          record.waiters.delete(waiter)
          resolve()
        }
        const timer = setTimeout(waiter, Math.min(100, Math.max(1, deadline - Date.now())))
        record.waiters.add(waiter)
      })
    }
    return this.publicRun(record)
  }

  async stop (id, reason = 'stopped_by_agent') {
    const record = this.#runs.get(id)
    if (!record) throw new Error(`找不到 ${id}`)
    if (!activeStatus(record)) return this.publicRun(record)
    record.status = reason === 'deadline_exceeded' ? 'timed_out' : reason === 'preempted' ? 'preempted' : 'cancelled'
    record.outcome = 'unknown'
    record.error = reason
    this.#appendLog(record, `run 终止：${reason}`)
    this.#cancelSubscriptions(record)
    record.controller.abort(reason)
    record.worker.postMessage({ type: 'abort', reason })
    if (reason === 'preempted') {
      await this.link.call('baritone.stop', {}).catch((error) => this.log(`抢占停止移动失败：${textOf(error)}`))
      await this.link.call('baritone.settings', { allow_break: false, allow_place: false })
        .catch((error) => this.log(`抢占恢复移动设置失败：${textOf(error)}`))
    }
    this.#finish(record, record.status, { error: reason })
    return this.publicRun(record)
  }

  async retireAll (reason) {
    await Promise.all([...this.#runs.values()].filter(activeStatus).map((record) => this.stop(record.id, reason)))
  }

  snapshot () {
    const runs = [...this.#runs.values()]
    return {
      active: runs.filter(activeStatus).length,
      total: runs.length,
      queued: runs.filter((record) => record.status === 'queued').length,
      running: runs.filter((record) => record.status === 'running').length,
      terminal: runs.filter((record) => !activeStatus(record)).length,
      dropped_events: runs.reduce((sum, record) => sum + record.droppedCount, 0),
    }
  }

  async dispose () {
    if (this.#disposed) return
    this.#disposed = true
    await this.retireAll('plugin_unloaded')
    this.#offEvent?.()
    this.#offEvent = null
  }

  publicRun (record) {
    return {
      run_id: record.id,
      owner: record.owner,
      status: record.status,
      outcome: record.outcome,
      created_at: record.createdAt,
      started_at: record.startedAt,
      ended_at: record.endedAt,
      timeout_ms: record.deadline,
      result: toLosslessJSON(record.result),
      error: record.error,
      checkpoint: toLosslessJSON(record.checkpoint),
      logs_count: record.logs.length,
      dropped_events: record.droppedCount,
      plugin_id: record.pluginId,
      priority: record.priority,
      parent_id: record.parentId,
      root_id: record.rootId,
      plugin_stack: [...record.pluginStack],
      mode: record.mode,
      subscriptions: [...record.subscriptions.values()].map((subscription) => ({
        id: subscription.id,
        filter: subscription.filter,
        queued: subscription.queue.length,
        dropped: subscription.dropped,
      })),
    }
  }

  #onMessage (record, frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'finished') {
      this.#finish(record, 'succeeded', { result: frame.result })
      return
    }
    if (frame.type === 'failed') {
      this.#finish(record, 'failed', { error: frame.error })
      return
    }
    if (frame.type === 'log') {
      this.#appendLog(record, textOf(frame.value))
      this.#respond(record, frame.id, { logged: true })
      return
    }
    if (frame.type === 'checkpoint') {
      record.checkpoint = toLosslessJSON(frame.value)
      try { this.onCheckpoint?.(record, record.checkpoint) } catch (error) { this.log(`checkpoint 持久化失败：${textOf(error)}`) }
      this.#respond(record, frame.id, { saved: true })
      return
    }
    this.#handleRequest(record, frame).catch((error) => {
      this.#respond(record, frame.id, undefined, error)
    })
  }

  async #handleRequest (record, frame) {
    this.#requireActive(record)
    if (frame.type === 'api.call') {
      if (!READ_METHODS.has(frame.method)) {
        if (!record.allowWrite || !this.scheduler) throw new Error(`只读脚本不允许调用 ${String(frame.method)}`)
        await this.scheduler.acquire(record, frame.method, record.controller.signal, frame.params ?? {})
      } else if (frame.method === 'getGuiState' && record.allowWrite && inventoryPluginIds.includes(record.pluginId)) {
        // Take the same lease as transfer before resolving menu slot indices.
        await this.scheduler.acquire(record, 'container.transfer', record.controller.signal)
      }
      const result = await this.link.call(frame.method, frame.params ?? {}, {
        timeoutMs: this.config.rpcTimeoutMs,
        signal: record.controller.signal,
      })
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'plugins.start') {
      if (!this.pluginHost) throw new Error('当前运行时不支持插件编排')
      const child = await this.pluginHost.start(frame.pluginId, { args: frame.args, owner: record.owner, parentId: record.id })
      this.#respond(record, frame.id, child)
      return
    }
    if (frame.type === 'plugins.wait') {
      if (!this.pluginHost) throw new Error('当前运行时不支持插件编排')
      const result = await this.pluginHost.wait(frame.runId, 300000)
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'plugins.stop') {
      if (!this.pluginHost) throw new Error('当前运行时不支持插件编排')
      const result = await this.pluginHost.stop(frame.pluginId, { parentId: record.id })
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'plugins.interrupt') {
      if (!this.pluginHost) throw new Error('当前运行时不支持插件编排')
      const result = await this.pluginHost.interrupt(record, frame.options ?? {})
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'notify') {
      if (!this.pluginHost) throw new Error('只读脚本没有通知能力')
      const result = await this.pluginHost.notify(record, frame.text)
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'screenshot') {
      if (!this.pluginHost) throw new Error('当前运行时不支持截图')
      const result = await this.pluginHost.screenshot(record, frame.params)
      this.#respond(record, frame.id, result)
      return
    }
    if (frame.type === 'events.subscribe') {
      const filter = normalizeEventFilter(frame.filter)
      await this.link.subscribe(filter.types)
      const id = `sub_${record.subscriptions.size + 1}_${randomUUID().slice(0, 6)}`
      record.subscriptions.set(id, {
        id,
        filter,
        queue: [],
        dropped: 0,
        overflowLogged: false,
        next: null,
      })
      this.#respond(record, frame.id, id)
      return
    }
    if (frame.type === 'events.next') {
      const subscription = record.subscriptions.get(frame.subscriptionId)
      if (!subscription) throw new Error(`事件订阅 ${frame.subscriptionId} 不存在或已退订`)
      if (subscription.next) throw new Error('同一个事件迭代器不能并发 next()')
      const value = await new Promise((resolve) => {
        subscription.next = resolve
        this.#pumpSubscription(record, subscription)
      })
      this.#respond(record, frame.id, value)
      return
    }
    if (frame.type === 'events.unsubscribe') {
      const subscription = record.subscriptions.get(frame.subscriptionId)
      if (subscription) {
        subscription.next?.({ done: true })
        record.subscriptions.delete(frame.subscriptionId)
      }
      this.#respond(record, frame.id, { done: true })
      return
    }
    throw new Error(`未知脚本能力 ${String(frame.type)}`)
  }

  #dispatch (event) {
    for (const record of this.#runs.values()) {
      if (!activeStatus(record)) continue
      for (const subscription of record.subscriptions.values()) {
        if (!eventMatches(subscription.filter, event)) continue
        if (subscription.queue.length >= this.config.eventQueueSize) {
          subscription.queue.shift()
          subscription.dropped += 1
          record.droppedCount += 1
          if (!subscription.overflowLogged) {
            subscription.overflowLogged = true
            this.#appendLog(record, `事件队列已满，丢弃最旧事件（subscription=${subscription.id}）`)
          }
        }
        subscription.queue.push(event)
        this.#pumpSubscription(record, subscription)
      }
    }
  }

  #pumpSubscription (record, subscription) {
    if (!subscription.next || subscription.queue.length === 0) return
    const resolve = subscription.next
    subscription.next = null
    const event = subscription.queue.shift()
    resolve({ done: false, value: event })
  }

  #requireActive (record) {
    if (!activeStatus(record)) throw new Error(`run 已终止（${record.status}）`)
    if (this.canControl(record.owner) === false) throw new Error('身体所有权已变更，旧 run 不能继续调用能力')
  }

  #respond (record, id, value, error) {
    if (!id) return
    try {
      record.worker.postMessage({ id, value: toLosslessJSON(value), error: error ? textOf(error?.message ?? error) : undefined })
    } catch { /* Worker 已终止时结果不再有意义 */ }
  }

  #appendLog (record, text) {
    const truncated = String(text ?? '').slice(0, this.config.maxLogChars)
    record.logs.push({ index: record.logSequence++, at: Date.now(), text: truncated })
    if (record.logs.length > this.config.maxLogs) record.logs.splice(0, record.logs.length - this.config.maxLogs)
  }

  #cancelSubscriptions (record) {
    for (const subscription of record.subscriptions.values()) {
      subscription.next?.({ done: true })
      subscription.next = null
      subscription.queue = []
    }
    record.subscriptions.clear()
  }

  #finish (record, status, { result, error } = {}) {
    if (record.endedAt !== null) return
    record.status = status
    if (status === 'failed' || status === 'preempted') record.outcome = 'unknown'
    if (result !== undefined) record.result = toLosslessJSON(result)
    if (error !== undefined) record.error = textOf(error)
    record.endedAt = Date.now()
    clearTimeout(record.timer)
    this.#cancelSubscriptions(record)
    record.controller.abort(status)
    this.scheduler?.release(record.id)
    record.worker.terminate().catch(() => {})
    for (const resolve of record.waiters) resolve()
    record.waiters.clear()
    this.#pruneHistory()
    Promise.resolve(this.onFinal?.(this.publicRun(record))).catch((failure) => this.log(`run 收尾失败：${textOf(failure)}`))
  }

  #pruneHistory () {
    if (this.#runs.size <= this.config.historySize) return
    for (const record of this.#runs.values()) {
      if (this.#runs.size <= this.config.historySize) break
      if (!activeStatus(record)) this.#runs.delete(record.id)
    }
  }
}
