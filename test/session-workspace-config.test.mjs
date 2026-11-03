import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceConfig } from '../src/plugin/workspace-config.mjs'
import { SessionPluginManager } from '../src/plugin/session-manager.mjs'
import { PluginRegistry } from '../src/plugin/registry.mjs'
import { ScriptRuntime } from '../src/script/runtime.mjs'
import { ActionScheduler } from '../src/plugin/scheduler.mjs'

const SERVICE = `export default async function(ctx) {
  await ctx.checkpoint({value:ctx.args.value})
  await ctx.sleep(100000)
}`

async function until (predicate, message = 'condition') {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时：${message}`)
}

async function editConfig (workspace, mutate) {
  const file = join(workspace, 'config', 'plugins.json')
  const config = JSON.parse(await readFile(file, 'utf8'))
  await mutate(config)
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function environment (t, root, { damageWatch = { enabled: false } } = {}) {
  const link = {
    call: async () => ({}),
    subscribe: async () => ({}),
    onEvent: () => () => {},
  }
  const scheduler = new ActionScheduler()
  const runtime = new ScriptRuntime({ link, scheduler })
  scheduler.bindRuntime(runtime)
  const manager = new SessionPluginManager({
    registry: new PluginRegistry(), runtime, scheduler, damageWatch,
    ownerRoot: (owner) => owner === 'child' ? 'a' : owner,
    workspace: async (owner) => join(root, owner),
  })
  t.after(async () => {
    await manager.dispose()
    await runtime.dispose()
  })
  return { manager, runtime }
}

test('工作区初始化不覆盖文件，core/user 配置和脚本经过完整校验', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-workspace-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = new WorkspaceConfig({ workspace: root, damageWatch: { enabled: false } })
  await config.initialize()
  const original = await readFile(config.configFile, 'utf8')
  await config.initialize()
  assert.equal(await readFile(config.configFile, 'utf8'), original)

  await editConfig(root, (raw) => { raw.plugins['core.damage_watch'].manifest = { priority: 1 } })
  await assert.rejects(config.load(), /未知字段 manifest/)
  await editConfig(root, (raw) => {
    delete raw.plugins['core.damage_watch'].manifest
    raw.plugins['core.damage_watch'].args.damageCooldownMs = -1
  })
  await assert.rejects(config.load(), /damageCooldownMs/)
  await editConfig(root, (raw) => {
    raw.plugins['core.damage_watch'].args.damageCooldownMs = 1000
    raw.plugins['user.bad'] = { enabled: true, manifest: { mode: 'service' }, args: {} }
  })
  await writeFile(join(root, 'scripts', 'bad.mjs'), SERVICE)
  await assert.rejects(config.load(), /persistent service/)
  await editConfig(root, (raw) => {
    raw.plugins['user.bad'].manifest.persistent = true
    raw.plugins['user.bad'].args.value = 7
  })
  const valid = await config.load()
  assert.equal(valid.registry.get('user.bad').manifest.args.value, 7)
  assert.equal(valid.registry.get('core.damage_watch').manifest.args.damageCooldownMs, 1000)
  await config.saveKnownGood(valid)
  await writeFile(config.configFile, '{broken', 'utf8')
  await assert.rejects(config.load(), /配置无效/)
  const fallback = await config.load({ allowFallback: true })
  assert.equal(fallback.degraded, true)
  assert.equal(fallback.registry.get('user.bad').manifest.args.value, 7)
  assert.match(fallback.warning, /最后有效版本/)
})

test('submit 只重启变化服务，非法配置零副作用，禁用和删除按声明应用', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-submit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { manager } = environment(t, root)
  await manager.prepare({ owner: 'a' })
  await manager.restore({ owner: 'a' })
  for (const [id, value] of [['user.first', 1], ['user.second', 10]]) {
    await manager.create({ id, code: SERVICE, manifest: { mode: 'service', persistent: true, args: { value } } }, { owner: 'a' })
    await manager.enable(id, { owner: 'a' })
  }
  const firstBefore = manager.get('user.first').active[0].run_id
  const secondBefore = manager.get('user.second').active[0].run_id
  await until(() => manager.status(firstBefore).status === 'running'
    && manager.status(secondBefore).status === 'running', 'both services running')
  await editConfig(join(root, 'a'), (raw) => { raw.plugins['user.first'].args.value = 2 })
  const submitted = await manager.submit({ owner: 'a' })
  assert.equal(submitted.changed, true)
  const firstAfter = manager.get('user.first').active[0].run_id
  assert.notEqual(firstAfter, firstBefore)
  assert.equal(manager.status(firstBefore).status, 'cancelled')
  assert.equal(manager.get('user.second').active[0].run_id, secondBefore)
  assert.equal(manager.status(secondBefore).status, 'running')
  await until(() => manager.status(firstAfter).checkpoint?.value === 2, 'new args checkpoint')

  await editConfig(join(root, 'a'), (raw) => { raw.plugins['user.second'].enabled = 'invalid' })
  await assert.rejects(manager.submit({ owner: 'a' }), /enabled 必须是布尔值/)
  assert.equal(manager.get('user.first').active[0].run_id, firstAfter)
  assert.equal(manager.get('user.second').active[0].run_id, secondBefore)
  assert.equal(manager.status(secondBefore).status, 'running')

  await editConfig(join(root, 'a'), (raw) => {
    raw.plugins['user.second'].enabled = true
    raw.plugins['user.first'].enabled = false
  })
  await manager.submit({ owner: 'a' })
  assert.equal(manager.get('user.first').active.length, 0)
  assert.equal(manager.status(firstAfter).status, 'cancelled')
  assert.equal(manager.get('user.second').active[0].run_id, secondBefore)
  await editConfig(join(root, 'a'), (raw) => { delete raw.plugins['user.first'] })
  await manager.submit({ owner: 'a' })
  assert.throws(() => manager.get('user.first'), /不存在/)
  const unchanged = await manager.submit({ owner: 'a' })
  assert.equal(unchanged.changed, false)
  assert.equal(manager.get('user.second').active[0].run_id, secondBefore)
})

test('双会话同名脚本和 submit 隔离，切回只恢复自己的服务', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-session-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { manager, runtime } = environment(t, root)
  for (const [owner, value] of [['a', 1], ['b', 2]]) {
    await manager.prepare({ owner })
    await manager.restore({ owner })
    await manager.create({
      id: 'user.same', code: SERVICE,
      manifest: { mode: 'service', persistent: true, args: { value } },
    }, { owner })
    await manager.enable('user.same', { owner })
    assert.equal(manager.get('user.same').manifest.args.value, value)
    await runtime.retireAll('test_switch')
  }
  await assert.rejects(async () => manager.submit({ owner: 'a' }), /未持有游戏身体/)
  await manager.prepare({ owner: 'a' })
  await manager.restore({ owner: 'a' })
  assert.equal(manager.get('user.same').manifest.args.value, 1)
  assert.equal(manager.get('user.same').active.length, 1)
  assert.equal(manager.list().filter((entry) => entry.kind === 'user').length, 1)
  const bConfig = JSON.parse(await readFile(join(root, 'b', 'config', 'plugins.json'), 'utf8'))
  assert.equal(bConfig.plugins['user.same'].args.value, 2)
})

test('init 生成 core 参考副本，修改 example 不影响注册表且下次 init 覆盖', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-builtin-examples-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { manager } = environment(t, root)
  await manager.prepare({ owner: 'a' })
  await manager.restore({ owner: 'a' })
  const exampleDir = join(root, 'a', 'scripts', 'example')
  const index = JSON.parse(await readFile(join(exampleDir, 'index.json'), 'utf8'))
  assert.equal(index.reference_only, true)
  assert.equal(index.plugins.length, 13)
  assert.ok(index.plugins.every((entry) => entry.id.startsWith('core.') && entry.manifest.mode))
  const original = manager.registry.get('core.open_block').code
  const exampleFile = join(exampleDir, 'core.open_block.mjs')
  assert.match(await readFile(exampleFile, 'utf8'), /参考副本/)
  await writeFile(exampleFile, 'export default async function(){return {result:"modified"}}', 'utf8')
  const submitted = await manager.submit({ owner: 'a' })
  assert.equal(submitted.changed, false)
  assert.equal(manager.registry.get('core.open_block').code, original)
  await manager.prepare({ owner: 'a' })
  assert.equal(await readFile(exampleFile, 'utf8'), `// 系统内置插件参考副本；修改本文件不会生效，下次 sirius_init 会覆盖。\n${original}`)
  assert.equal(manager.activationInfo().examples_dir, 'scripts/example')
})

test('子代理读取和提交主会话配置，不创建第二套工作区', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-subagent-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { manager } = environment(t, root)
  await manager.prepare({ owner: 'a' })
  await manager.restore({ owner: 'a' })
  await manager.create({
    id: 'user.child_config', code: SERVICE,
    manifest: { mode: 'service', persistent: true, args: { value: 4 } },
  }, { owner: 'a' })
  const config = await manager.config({ owner: 'child', validate: true })
  assert.equal(config.workspace, join(root, 'a'))
  await editConfig(join(root, 'a'), (raw) => { raw.plugins['user.child_config'].enabled = true })
  await manager.submit({ owner: 'child' })
  const active = manager.get('user.child_config').active[0]
  assert.equal(active.owner, 'a')
  await until(() => manager.status(active.run_id).checkpoint?.value === 4)
  const once = await manager.start('user.child_config', { owner: 'child' })
  assert.equal(once.run_id, active.run_id)
})

test('会话 runs.json 在进程重启后续做自己的 task，once 和别的会话不恢复', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sirius-session-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = environment(t, root)
  await first.manager.prepare({ owner: 'a' })
  await first.manager.restore({ owner: 'a' })
  await first.manager.create({
    id: 'user.resume',
    code: `export default async function(ctx) {
      if (ctx.args.resume_checkpoint) return {step:ctx.args.resume_checkpoint.step,from:ctx.args.resume_from}
      await ctx.checkpoint({step:2})
      await ctx.sleep(100000)
    }`,
    manifest: { mode: 'task' },
  }, { owner: 'a' })
  await first.manager.create({
    id: 'user.once', code: 'export default async function(ctx){await ctx.sleep(100000)}',
    manifest: { mode: 'once' },
  }, { owner: 'a' })
  const task = await first.manager.start('user.resume', { owner: 'a' })
  await first.manager.start('user.once', { owner: 'a' })
  await until(() => first.manager.status(task.run_id).checkpoint?.step === 2)
  await first.runtime.dispose()
  await first.manager.dispose()

  const second = environment(t, root)
  await second.manager.prepare({ owner: 'a' })
  const restored = await second.manager.restore({ owner: 'a' })
  const resumed = restored.find((run) => run.plugin_id === 'user.resume')
  const done = await second.manager.wait(resumed.run_id, 2000)
  assert.equal(done.result.step, 2)
  assert.equal(done.result.from, task.run_id)
  assert.equal(restored.some((run) => run.plugin_id === 'user.once'), false)
  const bRuns = JSON.parse(await readFile(join(root, 'a', 'state', 'runs.json'), 'utf8'))
  assert.equal(bRuns.runs.find((run) => run.run_id === task.run_id).status, 'interrupted')
  await second.manager.prepare({ owner: 'b' })
  const other = await second.manager.restore({ owner: 'b' })
  assert.equal(other.length, 0)
  assert.equal(second.manager.list().some((entry) => entry.id === 'user.resume'), false)
})
