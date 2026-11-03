import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

test('sirius_script.run 后台返回 run_id，status/logs/stop/list 使用同一运行时', async (t) => {
  const listeners = new Set()
  const link = {
    call: async (method) => method === 'getStats' ? { in_game: true, health: 19 } : { method },
    status: async () => ({ online: true, inGame: true, ready: true }),
    subscribe: async () => ({}),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    events: () => [],
  }
  const scripts = new ScriptRuntime({ link })
  t.after(() => scripts.dispose())
  const tools = createTools({
    ctx: { get: () => undefined },
    link,
    log: () => {},
    state: { scripts, capabilities: { protocol: '1.11' } },
  })
  const tool = tools.find((candidate) => candidate.name === 'sirius_script')
  const started = await tool.execute({
    action: 'run',
    code: 'export default async function(ctx) { const s=await ctx.api.call("getStats",{}); await ctx.log(s.health); return s }',
    args: {},
    wait_ms: 2000,
  }, { agent: { id: 'owner' } })
  assert.ok(started.data.run_id)
  const status = await tool.execute({ action: 'status', run_id: started.data.run_id }, {})
  assert.equal(status.data.status, 'succeeded')
  assert.equal(status.data.result.health, 19)
  const logs = await tool.execute({ action: 'logs', run_id: started.data.run_id }, {})
  assert.equal(logs.data.logs[0].text, '19')
  const list = await tool.execute({ action: 'list' }, {})
  assert.equal(list.data.runs.length, 1)
  const stopped = await tool.execute({ action: 'stop', run_id: started.data.run_id }, {})
  assert.equal(stopped.data.status, 'succeeded')
})

test('sirius_stop 是系统级停止，会取消全部后台 run', async (t) => {
  const link = {
    call: async (method) => method === 'getStats'
      ? { in_game: true, health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }
      : { result: 'stopped', method },
    status: async () => ({ online: true, inGame: true, ready: true }),
    subscribe: async () => ({}),
    onEvent: () => () => {},
    events: () => [],
  }
  const scripts = new ScriptRuntime({ link })
  t.after(() => scripts.dispose())
  const tools = createTools({
    ctx: { get: () => undefined }, link, log: () => {},
    state: { scripts, capabilities: { protocol: '1.11' }, canControl: () => true },
  })
  const script = tools.find((candidate) => candidate.name === 'sirius_script')
  const started = await script.execute({ action: 'run', code: 'export default async function(ctx) { await ctx.sleep(100000) }' }, {})
  const stop = tools.find((candidate) => candidate.name === 'sirius_stop')
  await stop.execute({}, {})
  assert.equal(scripts.get(started.data.run_id).status, 'cancelled')
  assert.equal(scripts.get(started.data.run_id).error, 'sirius_stop')
})
