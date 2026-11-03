import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

const pending = new Map()
let sequence = 0
const controller = new AbortController()

function request (type, payload = {}) {
  const id = `${workerData.runId}:${++sequence}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type, id, ...payload })
  })
}

parentPort.on('message', (frame) => {
  if (frame.type === 'abort') {
    controller.abort(frame.reason)
    return
  }
  const entry = pending.get(frame.id)
  if (!entry) return
  pending.delete(frame.id)
  if (frame.error) entry.reject(new Error(frame.error))
  else entry.resolve(frame.value)
})

function serializableError (error) {
  return String(error?.stack ?? error?.message ?? error).slice(0, 8000)
}

const ctx = {
  api: {
    call: (method, params = {}) => request('api.call', { method, params }),
  },
  plugins: {
    start: (pluginId, args = {}) => request('plugins.start', { pluginId, args }),
    wait: (runId) => request('plugins.wait', { runId }),
    stop: (pluginId) => request('plugins.stop', { pluginId }),
    interrupt: (options = {}) => request('plugins.interrupt', { options }),
  },
  notify: (text) => request('notify', { text }),
  screenshot: (params = {}) => request('screenshot', { params }),
  events: {
    subscribe: async (filter) => {
      const subscriptionId = await request('events.subscribe', { filter })
      return {
        [Symbol.asyncIterator] () { return this },
        next: () => request('events.next', { subscriptionId }),
        return: async () => {
          await request('events.unsubscribe', { subscriptionId })
          return { done: true }
        },
      }
    },
  },
  sleep: (ms) => new Promise((resolve, reject) => {
    if (!Number.isFinite(ms) || ms < 0 || ms > 300000) {
      reject(new Error('sleep 只接受 0..300000ms'))
      return
    }
    if (controller.signal.aborted) {
      reject(new Error('run 已取消'))
      return
    }
    const timer = setTimeout(() => {
      controller.signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(new Error('run 已取消'))
    }
    controller.signal.addEventListener('abort', aborted, { once: true })
  }),
  signal: controller.signal,
  log: (value) => request('log', { value }),
  checkpoint: (value) => request('checkpoint', { value }),
  args: workerData.args,
  runId: workerData.runId,
  now: () => Date.now(),
  state: {},
}

try {
  const transformed = workerData.code.replace(/\bexport\s+default\s+/, 'module.exports =')
  const source = `(async () => { const module = { exports: {} };\n${transformed}\n;return module.exports })()`
  const run = await vm.runInContext(source, vm.createContext({
    ctx,
    AbortController,
    AbortSignal,
    JSON,
    Math,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    URL,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Symbol,
    BigInt,
    console: undefined,
    setTimeout: undefined,
    clearTimeout: undefined,
    setInterval: undefined,
    clearInterval: undefined,
    require: undefined,
    process: undefined,
    global: undefined,
    globalThis: undefined,
  }), { timeout: 1000, filename: `sirius-${workerData.runId}.mjs` })
  if (typeof run !== 'function') throw new Error('脚本必须 export default 一个 async function(ctx)')
  const result = await run(ctx)
  parentPort.postMessage({ type: 'finished', result })
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: serializableError(error) })
}
