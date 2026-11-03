import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'
import { PluginManager } from '../src/plugin/manager.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'

function environment ({ storageFile, runStateFile }) {
  const link = {
    call: async () => ({ result: 'ok' }),
    subscribe: async () => ({}),
    onEvent: () => () => {},
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new PluginManager({
    registry: new PluginRegistry({ storageFile }), runtime, scheduler, runStateFile,
  })
  return { manager, runtime }
}

async function until (predicate) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待 checkpoint 超时')
}

test('进程重启恢复 task checkpoint，once 不重放，旧 run 标记 interrupted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sirius-run-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storageFile = join(dir, 'plugins.json')
  const runStateFile = join(dir, 'runs.json')
  const first = environment({ storageFile, runStateFile })
  first.manager.create({
    id: 'user.resume',
    code: `export default async function(ctx) {
      if (ctx.args.resume_checkpoint) return { step:ctx.args.resume_checkpoint.step, from:ctx.args.resume_from }
      await ctx.checkpoint({step:2})
      await ctx.sleep(100000)
    }`,
    manifest: { mode: 'task' },
  })
  first.manager.create({
    id: 'user.once',
    code: 'export default async function(ctx) { await ctx.sleep(100000) }',
    manifest: { mode: 'once' },
  })
  const task = await first.manager.start('user.resume', { owner: 'owner' })
  await first.manager.start('user.once', { owner: 'owner' })
  await until(() => first.manager.status(task.run_id).checkpoint?.step === 2)
  await first.runtime.dispose()
  await first.manager.dispose()

  const second = environment({ storageFile, runStateFile })
  t.after(async () => { await second.manager.dispose(); await second.runtime.dispose() })
  const runs = await second.manager.restore({ owner: 'owner' })
  const restored = runs.find((run) => run.plugin_id === 'user.resume')
  const done = await second.manager.wait(restored.run_id, 2000)
  assert.equal(done.status, 'succeeded', JSON.stringify(done))
  assert.equal(done.result.step, 2)
  assert.equal(done.result.from, task.run_id)
  assert.equal(runs.some((run) => run.plugin_id === 'user.once'), false)
  const stored = JSON.parse(await readFile(runStateFile, 'utf8'))
  assert.equal(stored.runs.find((run) => run.run_id === task.run_id).status, 'interrupted')
})

test('enabled service 重启后收到最近 checkpoint', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sirius-service-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storageFile = join(dir, 'plugins.json')
  const runStateFile = join(dir, 'runs.json')
  const first = environment({ storageFile, runStateFile })
  first.manager.create({
    id: 'user.service',
    code: `export default async function(ctx) {
      if (ctx.args.resume_checkpoint) return { restored:ctx.args.resume_checkpoint.ready }
      await ctx.checkpoint({ready:true})
      await ctx.sleep(100000)
    }`,
    manifest: { mode: 'service' },
  })
  const { run } = await first.manager.enable('user.service', { owner: 'owner' })
  await until(() => first.manager.status(run.run_id).checkpoint?.ready === true)
  await first.runtime.dispose()
  await first.manager.dispose()

  const second = environment({ storageFile, runStateFile })
  t.after(async () => { await second.manager.dispose(); await second.runtime.dispose() })
  await second.manager.restore({ owner: 'owner' })
  const active = second.manager.get('user.service').active[0]
  const done = await second.manager.wait(active.run_id, 2000)
  assert.equal(done.result.restored, true)
})
