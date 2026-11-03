import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools, TOOL_NAMES } from '../src/tools.mjs'

const READY = {
  online: true,
  inGame: true,
  ready: true,
  screen: null,
  gameMode: 'creative',
  health: 20,
  food: 20,
  position: { x: 0, y: 64, z: 0 },
}

function makeLink ({ status = READY, responder } = {}) {
  const calls = []
  return {
    calls,
    link: {
      status: async () => status,
      call: async (method, params) => {
        calls.push({ method, params })
        return responder ? responder(method, params) : { ok: true, method, params }
      },
      subscribe: async (types) => { calls.push({ method: 'events.subscribe', params: { types, min_level: null } }); return { subscribed: true, types } },
      events: () => [],
      onEvent: () => () => {},
    },
  }
}

const build = (options) => createTools({ ctx: { get: () => undefined }, link: makeLink(options).link, log: () => {} })
const find = (tools, name) => tools.find((tool) => tool.name === name)

test('30 个工具，名字与 TOOL_NAMES 一致', () => {
  const tools = build()
  assert.equal(tools.length, TOOL_NAMES.length)
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
})

test('每个工具都满足宿主 ToolDefinition 的最小契约', () => {
  for (const tool of build()) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} 缺描述`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    const required = tool.parameters.required ?? []
    for (const key of required) {
      assert.ok(Object.hasOwn(tool.parameters.properties, key), `${tool.name}.required 里的 ${key} 不在 properties`)
    }
  }
})

test('参数 schema 只用宿主支持的关键字（minimum/maximum 之类会让注册抛错）', () => {
  const allowed = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples',
  ])
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      assert.ok(allowed.has(key), `${path}.${key} 不在宿主支持的关键字里`)
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) walk(child, `${path}.properties.${name}`)
      } else if (key === 'items') {
        walk(value, `${path}.items`)
      } else if (key === 'oneOf' && Array.isArray(value)) {
        value.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`))
      }
    }
  }
  for (const tool of build()) walk(tool.parameters, tool.name)
})

test('render 返回 content blocks（含 summary 文本）', () => {
  const tool = find(build(), 'sirius_status')
  const blocks = tool.output.render({}, { summary: 'hello', data: { a: 1 } })
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /hello/)
  assert.ok(blocks.length >= 2) // summary + data
})

test('工具返回值一定会被压成无损 JSON（undefined 键被删掉）', async () => {
  // 宿主对工具返回值做 JsonValue 校验：带 undefined 就报
  // `invalid output: value is not lossless JSON`，而动作其实已经成功了（2026-11-01 用户报）。
  const tool = find(createTools({
    ctx: { get: () => undefined },
    link: makeLink({
      status: {
        online: true, inGame: false, screen: 'TitleScreen', ready: false,
        position: undefined, gameMode: undefined, health: Number.NaN,
      },
    }).link,
    log: () => {},
  }), 'sirius_status')
  const value = await tool.execute({}, {})
  assert.ok(!('position' in value.data), `不该留 undefined 键：${JSON.stringify(Object.keys(value.data))}`)
  assert.ok(!('gameMode' in value.data))
  assert.equal(value.data.health, null, 'NaN 应降级成 null')
})

test('身体所有权：非所有者只能读和 init，所有者才可行动', async () => {
  const { link, calls } = makeLink()
  const state = {
    capabilities: { protocol: '1.6' },
    canControl: (id) => id === 'owner',
    init: async (exec) => ({ result: 'initialized', owner: exec.agent.id, previous_owner: 'owner' }),
  }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const other = { agent: { id: 'other' } }
  await assert.rejects(find(tools, 'sirius_say').execute({ text: '不该发出' }, other), /sirius_init/)
  assert.equal(calls.filter((call) => call.method === 'chat.send').length, 0)

  const status = await find(tools, 'sirius_status').execute({}, other)
  assert.equal(status.data.body.can_control, false)
  assert.match(status.summary, /sirius_init/)

  const initialized = await find(tools, 'sirius_init').execute({}, other)
  assert.equal(initialized.data.result, 'initialized')
  assert.equal(initialized.data.owner, 'other')
  await find(tools, 'sirius_say').execute({ text: '所有者可以说话' }, { agent: { id: 'owner' } })
  assert.equal(calls.filter((call) => call.method === 'chat.send').length, 1)
})

test('sirius_plugin 配置操作支持预检和提交，非所有者不能改变挂载', async () => {
  const calls = []
  const state = {
    canControl: (id) => id === 'owner',
    plugins: {
      config: async (input) => {
        calls.push({ action: input.validate ? 'validate' : 'config', owner: input.owner })
        return { result: input.validate ? 'valid' : 'loaded', plugins: 13, enabled: 1 }
      },
      submit: async (input) => {
        calls.push({ action: 'submit', owner: input.owner })
        return { changes: [], started: [], stopped: [] }
      },
    },
  }
  const tools = createTools({ ctx: { get: () => undefined }, link: makeLink().link, log: () => {}, state })
  const plugin = find(tools, 'sirius_plugin')
  assert.equal((await plugin.execute({ action: 'config' }, { agent: { id: 'other' } })).data.result, 'loaded')
  assert.equal((await plugin.execute({ action: 'validate' }, { agent: { id: 'other' } })).data.result, 'valid')
  await plugin.execute({ action: 'submit' }, { agent: { id: 'owner' } })
  await assert.rejects(plugin.execute({ action: 'submit' }, { agent: { id: 'other' } }), /未持有游戏身体/)
  assert.deepEqual(calls, [
    { action: 'config', owner: 'other' },
    { action: 'validate', owner: 'other' },
    { action: 'submit', owner: 'owner' },
  ])
})

test('身体所有权：子代理不能通过 init 夺取主会话身体', async () => {
  let calls = 0
  const state = {
    capabilities: { protocol: '1.6' },
    subagentIds: new Set(['child']),
    init: async () => { calls += 1; return { result: 'initialized' } },
  }
  const tools = createTools({ ctx: { get: () => undefined }, link: makeLink().link, log: () => {}, state })
  await assert.rejects(find(tools, 'sirius_init').execute({}, { agent: { id: 'child' } }), /主会话/)
  assert.equal(calls, 0)
})

test('sirius_say 转发 chat.send；界面开着也照发（睡觉/死亡屏），不在游戏里才拒', async () => {
  const say = find(build(), 'sirius_say')
  const { link, calls } = makeLink()
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_say')
  await tool.execute({ text: 'hi' }, {})
  assert.deepEqual(calls.at(-1), { method: 'chat.send', params: { string: 'hi' } })

  // 🔴 2026-10-31 真机（用户报"在床上发不出消息"）：InBedChatScreen 让 ready=false，
  //    但 chat.send 是界面免疫的 —— 这条路径必须放行，否则躺着就变哑巴。
  const inBed = find(createTools({
    ctx: { get: () => undefined },
    link: makeLink({ status: { ...READY, ready: false, screen: 'InBedChatScreen' } }).link,
    log: () => {},
  }), 'sirius_say')
  await inBed.execute({ text: '我睡了' }, {})

  const notInGame = find(createTools({
    ctx: { get: () => undefined },
    link: makeLink({ status: { ...READY, ready: false, inGame: false, screen: 'TitleScreen' } }).link,
    log: () => {},
  }), 'sirius_say')
  await assert.rejects(notInGame.execute({ text: 'hi' }, {}), /不在游戏/)
  assert.ok(say)
})

test('sirius_place 转发 place 并把 verdict 写进 summary', async () => {
  const { link, calls } = makeLink({
    responder: (method) => (method === 'place'
      ? { in_game: true, result: 'blocked', block: 'minecraft:granite', face: 'down', reason: 'not replaceable' }
      : { ok: true }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_place')
  const value = await tool.execute({ x: -22, y: 103, z: -801, item: 'minecraft:stone' }, {})
  assert.deepEqual(calls.at(-1), {
    method: 'place',
    params: { x: -22, y: 103, z: -801, item: 'minecraft:stone' },
  })
  assert.match(value.summary, /blocked/)
  assert.match(value.summary, /not replaceable/)
})

test('sirius_command 走 GUI 聊天栏：T → 文本 → ENTER（并给出 verify 结论）', async () => {
  // 用"状态机"而不是"第几次调用"：verify 会多打几次 getGuiState，按次数写死会错位
  let screenOpen = false
  const { link, calls } = makeLink({
    responder: (method, params) => {
      if (method === 'getGuiState') {
        return { screen_open: screenOpen, screen_class: screenOpen ? 'ChatScreen' : null, widgets: screenOpen ? [{ type: 'EditBox', text: '' }] : [] }
      }
      if (method === 'input.key') {
        if (params.code === 84) screenOpen = true
        else if (params.code === 257 || params.code === 256) screenOpen = false
        return { ok: true }
      }
      return { ok: true }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_command')
  const value = await tool.execute({ text: '/give @s minecraft:stone 4' }, {})
  const seq = calls.map((c) => c.method).filter((m) => m !== 'getGuiState')
  assert.deepEqual(seq, ['input.key', 'input.text', 'input.key'])
  assert.equal(calls.filter((c) => c.method === 'input.key')[0].params.code, 84) // T
  assert.equal(calls.filter((c) => c.method === 'input.key')[1].params.code, 257) // ENTER
  assert.match(value.summary, /已发送命令/)
  // 聊天栏开了又关 = 文本确实提交了，但 fake 里没有服务端回执 → verify 只能给 sent
  assert.equal(value.data.verify, 'sent')
})

test('sirius_command：发完 300ms 内有新聊天 → verify=confirmed', async () => {
  const { link } = makeLink({
    responder: (method) => (method === 'getGuiState' ? { screen_open: false } : { ok: true }),
  })
  // 游标之后能读到一条新聊天 = 有观测证据
  link.events = (opts = {}) => (opts.since != null
    ? [{ seq: 9, event: 'chat', data: { message: '<[Server]> 现在有 4 人在线' } }]
    : [{ seq: 3, event: 'chat', data: { message: '<Steve> 旧消息' } }])
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_command')
  const value = await tool.execute({ text: '#stop' }, {})
  assert.equal(value.data.verify, 'confirmed')
  assert.match(value.summary, /回执/)
  assert.deepEqual(value.data.evidence.chat, ['<[Server]> 现在有 4 人在线'])
})

test('sirius_command：没有任何回执时 verify=sent（发得出去但服务端静默）', async () => {
  const { link } = makeLink({
    responder: (method) => (method === 'getGuiState' ? { screen_open: false } : { ok: true }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_command')
  const value = await tool.execute({ text: '#stop' }, {}) // # 走 chat.send，不开界面
  assert.equal(value.data.verify, 'sent')
  assert.match(value.data.channel, /chat\.send/)
})

test('sirius_look：at 走 lookAt，yaw/pitch 走 look，缺参报错', async () => {
  const { link, calls } = makeLink({
    responder: (method, params) => ({ in_game: true, looked: true, yaw: params.yaw ?? 12, pitch: params.pitch ?? 34, distance: 3 }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_look')
  await tool.execute({ at: { x: 1, y: 2, z: 3 }, turn_speed_deg_s: 360 }, {})
  assert.equal(calls.at(-1).method, 'lookAt')
  assert.deepEqual(calls.at(-1).params, { x: 1, y: 2, z: 3, turn_speed_deg_s: 360 })

  await tool.execute({ yaw: 90, pitch: 0 }, {})
  assert.equal(calls.at(-1).method, 'look')
  assert.deepEqual(calls.at(-1).params, { yaw: 90, pitch: 0 })

  await assert.rejects(tool.execute({ yaw: 10 }, {}), /at.*yaw.*pitch/)
})

test('sirius_screenshot：只保存到工作区 images 并返回 read_image 路径', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sirius-screenshot-'))
  try {
    const { link } = makeLink({
      responder: () => ({ image_b64: 'AAAA', format: 'jpeg', width: 854, height: 480, quality: 80 }),
    })
    const state = { workspaceDir: async () => workspace }
    const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state }), 'sirius_screenshot')
    const value = await tool.execute({ tier: 'full' }, {})
    assert.match(value.summary, /854×480/)
    assert.match(value.summary, /read_image/)
    assert.match(value.data.relative_path, /^images\/sirius-.*\.jpg$/)
    assert.equal(value.data.path, join(workspace, value.data.relative_path))
    assert.equal(value.image, undefined)
    assert.deepEqual(await readFile(value.data.path), Buffer.from('AAAA', 'base64'))
    const blocks = tool.output.render({}, value)
    assert.ok(blocks.every((block) => block.type === 'text'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('sirius_screenshot：超过六张仍逐张保存且路径唯一', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sirius-screenshot-'))
  try {
    const { link } = makeLink({
      responder: () => ({ image_b64: 'AAAA', format: 'jpeg', width: 10, height: 10, quality: 50 }),
    })
    const state = { workspaceDir: async () => workspace }
    const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state }), 'sirius_screenshot')
    const paths = new Set()
    for (let index = 0; index < 8; index += 1) {
      const value = await tool.execute({}, {})
      paths.add(value.data.relative_path)
      assert.equal(value.image, undefined)
    }
    assert.equal(paths.size, 8)
    assert.equal((await readdir(join(workspace, 'images'))).length, 8)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('sirius_screenshot：无法确定工作区时明确失败', async () => {
  const { link } = makeLink({
    responder: () => ({ image_b64: 'AAAA', format: 'jpeg', width: 10, height: 10, quality: 50 }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_screenshot')
  await assert.rejects(tool.execute({}, {}), /工作区/)
})

test('sirius_events 订阅并返回缓冲', async () => {
  const rows = [{ event: 'chat', data: { message: '<Steve> hi' }, seq: 3 }]
  const { link, calls } = makeLink()
  link.events = () => rows
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_events')
  const value = await tool.execute({ types: ['chat'], limit: 5 }, {})
  assert.deepEqual(calls.at(-1), { method: 'events.subscribe', params: { types: ['chat'], min_level: null } })
  assert.match(value.summary, /1 条事件/)
  assert.equal(value.data.events.length, 1)
})

test('sirius_events 默认包含 damage，但不订阅大体积 screenshot 事件', async () => {
  const rows = [{ event: 'damage', data: { health_before: 20, health_after: 19 }, seq: 4 }]
  const { link, calls } = makeLink()
  let filter = null
  link.events = (options) => { filter = options; return rows }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_events')
  const value = await tool.execute({}, {})
  const subscribed = calls.at(-1).params.types
  assert.ok(subscribed.includes('damage'))
  assert.ok(!subscribed.includes('screenshot'))
  assert.deepEqual(filter.types, subscribed)
  assert.equal(value.data.events[0].event, 'damage')
})

// ---------------------------------------------------------------- 1.6 新工具（转发契约）

test('sirius_select：转发 inventory.select，摘要给前后选中格', async () => {
  const { link, calls } = makeLink({
    responder: (method) => (method === 'inventory.select'
      ? { in_game: true, selected: 3, previous: 0, item: { name: 'minecraft:iron_sword', count: 1 } }
      : { ok: true }),
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } })
  const value = await find(tools, 'sirius_select').execute({ slot: 3 }, {})
  assert.deepEqual(calls.at(-1), { method: 'inventory.select', params: { slot: 3 } })
  assert.match(value.summary, /0 → 3/)
  assert.match(value.summary, /iron_sword/)
})

test('sirius_use_item：转发 useItem，摘要给 interaction 与手里物品变化', async () => {
  const { link, calls } = makeLink({
    responder: (method) => (method === 'useItem'
      ? { in_game: true, result: 'used', interaction: 'consume', item_before: { name: 'minecraft:bread', count: 5 }, item_after: { name: 'minecraft:bread', count: 4 } }
      : { ok: true }),
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } })
  const value = await find(tools, 'sirius_use_item').execute({ times: 2 }, {})
  assert.equal(calls.at(-1).method, 'useItem')
  assert.equal(calls.at(-1).params.times, 2)
  assert.match(value.summary, /used/)
  assert.match(value.summary, /bread/)
})

test('sirius_use_entity / sirius_attack：目标三选一透传，摘要带实体与 verdict', async () => {
  const { link, calls } = makeLink({
    responder: (method) => {
      if (method === 'entity.use') return { in_game: true, result: 'screen_opened', screen_class: 'MerchantScreen', entity: { name: '村民', type: 'minecraft:villager', distance: 1.8 } }
      if (method === 'entity.attack') return { in_game: true, result: 'hit', hits: 2, miss: 0, entity: { name: '僵尸', type: 'minecraft:zombie' } }
      return { ok: true }
    },
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } })
  const used = await find(tools, 'sirius_use_entity').execute({ name: '村民', at: 'center' }, {})
  assert.deepEqual(calls.at(-1).params, { name: '村民', at: 'center' })
  assert.match(used.summary, /screen_opened/)
  assert.match(used.summary, /MerchantScreen/)

  const hit = await find(tools, 'sirius_attack').execute({ uuid: 'abc', count: 3 }, {})
  assert.deepEqual(calls.at(-1).params, { uuid: 'abc', count: 3 })
  assert.match(hit.summary, /hit/)
  assert.match(hit.summary, /命中 2 次/)
})

test('sirius_attack until=dead：锁定首次目标并汇总到死亡', async () => {
  let round = 0
  const attemptParams = []
  const { link, calls } = makeLink({
    responder: (method, params) => {
      if (method !== 'entity.attack') return { ok: true }
      attemptParams.push({ ...params })
      round += 1
      return round === 1
        ? { in_game: true, result: 'hit', hits: 1, miss: 1, entity: { uuid: 'zombie-1', name: '僵尸', type: 'minecraft:zombie', health: 12 } }
        : { in_game: true, result: 'dead', hits: 1, miss: 0, entity: { uuid: 'zombie-1', name: '僵尸', type: 'minecraft:zombie', health: 0 } }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ name: '僵尸', until: 'dead', interval_ms: 0, max_seconds: 5 }, {})
  const attacks = calls.filter((call) => call.method === 'entity.attack')
  assert.equal(attacks.length, 2)
  assert.deepEqual(attemptParams[0], { name: '僵尸', interval_ms: 0, count: 1 })
  assert.deepEqual(attemptParams[1], { uuid: 'zombie-1', interval_ms: 0, count: 1 })
  assert.equal(value.data.result, 'dead')
  assert.equal(value.data.attempts, 2)
  assert.equal(value.data.hits, 2)
  assert.equal(value.data.miss, 1)
  assert.equal(value.data.target_health_before, 12)
  assert.equal(value.data.target_health_after, 0)
  assert.match(value.summary, /dead/)
  assert.match(value.summary, /2 轮/)
})

test('sirius_attack until=dead：超距立即收手，不盲目重试', async () => {
  const { link, calls } = makeLink({
    responder: (method) => (method === 'entity.attack'
      ? { in_game: true, result: 'out_of_range', hits: 0, miss: 1, reason: '3.2 blocks away', entity: { uuid: 'zombie-1', name: '僵尸', health: 20 } }
      : { ok: true }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead', interval_ms: 0 }, {})
  assert.equal(value.data.result, 'out_of_range')
  assert.equal(value.data.attempts, 1)
  assert.equal(calls.filter((call) => call.method === 'entity.attack').length, 1)
})

test('sirius_attack until=dead：低血时零成本收手', async () => {
  let attacks = 0
  const { link } = makeLink({
    status: { ...READY, health: 8 },
    responder: (method) => {
      if (method === 'entity.attack') attacks += 1
      return { ok: true }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead' }, {})
  assert.equal(value.data.result, 'low_health')
  assert.equal(value.data.attempts, 0)
  assert.equal(attacks, 0)
})

test('sirius_attack until=dead：攻击途中低血会停止后续攻击', async () => {
  const status = { ...READY, health: 20 }
  const { link, calls } = makeLink({
    status,
    responder: (method) => {
      if (method !== 'entity.attack') return { ok: true }
      status.health = 7
      return { in_game: true, result: 'hit', hits: 1, miss: 0, entity: { uuid: 'zombie-1', name: '僵尸', health: 12 } }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead', interval_ms: 0 }, {})
  assert.equal(value.data.result, 'low_health')
  assert.equal(value.data.player_health, 7)
  assert.equal(value.data.attempts, 1)
  assert.equal(calls.filter((call) => call.method === 'entity.attack').length, 1)
})

test('sirius_attack until=dead：没有 uuid 就不冒险切换同名目标', async () => {
  const { link, calls } = makeLink({
    responder: (method) => (method === 'entity.attack'
      ? { in_game: true, result: 'hit', hits: 1, miss: 0, entity: { name: '僵尸', type: 'minecraft:zombie', health: 19 } }
      : { ok: true }),
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ name: '僵尸', until: 'dead', interval_ms: 0 }, {})
  assert.equal(value.data.result, 'target_unstable')
  assert.equal(value.data.attempts, 1)
  assert.equal(calls.filter((call) => call.method === 'entity.attack').length, 1)
})

test('sirius_attack until=dead：调用方取消时不发起攻击', async () => {
  let attacks = 0
  const { link } = makeLink({
    responder: (method) => {
      if (method === 'entity.attack') attacks += 1
      return { ok: true }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead' }, { signal: AbortSignal.abort() })
  assert.equal(value.data.result, 'interrupted')
  assert.equal(value.data.attempts, 0)
  assert.equal(attacks, 0)
})

test('sirius_attack until=dead：超过总时限后返回 timeout', async () => {
  const { link, calls } = makeLink({
    responder: async (method) => {
      if (method !== 'entity.attack') return { ok: true }
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      return { in_game: true, result: 'hit', hits: 1, miss: 0, entity: { uuid: 'zombie-1', name: '僵尸', health: 19 } }
    },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead', interval_ms: 0, max_seconds: 1 }, {})
  assert.equal(value.data.result, 'timeout')
  assert.equal(value.data.attempts, 1)
  assert.equal(calls.filter((call) => call.method === 'entity.attack').length, 1)
})

test('sirius_attack until=dead：init 接管后在下一击前退出', async () => {
  let allowed = true
  const { link, calls } = makeLink({
    responder: (method) => {
      if (method !== 'entity.attack') return { ok: true }
      allowed = false
      return { in_game: true, result: 'hit', hits: 1, miss: 0, entity: { uuid: 'zombie-1', name: '僵尸', health: 19 } }
    },
  })
  const state = { capabilities: { protocol: '1.6' }, canControl: () => allowed }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state }), 'sirius_attack')
  const value = await tool.execute({ uuid: 'zombie-1', until: 'dead', interval_ms: 0 }, { agent: { id: 'old-owner' } })
  assert.equal(value.data.result, 'interrupted')
  assert.equal(value.data.attempts, 1)
  assert.match(value.data.reason, /sirius_init/)
  assert.equal(calls.filter((call) => call.method === 'entity.attack').length, 1)
})

test('sirius_baritone / sirius_chat_history：解析状态与来源前缀', async () => {
  const { link } = makeLink({
    responder: (method) => {
      if (method === 'baritone.status') return { state: 'no_path', goal: null, last_line: 'Unable to find a path', lines: ['Unable to find a path'], captured: true }
      if (method === 'chat.history') return { lines: [{ t: 1, source: 'client', text: 'Unable to find a path' }, { t: 2, source: 'server', text: '<A> 你好' }], count: 2, captured: true }
      return { ok: true }
    },
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.7' } } })
  const state = await find(tools, 'sirius_baritone').execute({}, {})
  assert.match(state.summary, /no_path/)
  const history = await find(tools, 'sirius_chat_history').execute({ source: 'all' }, {})
  assert.equal(history.data.count, 2)
  assert.match(history.summary, /· Unable to find a path/)
  assert.match(history.summary, /> <A> 你好/)
})

test('1.6 工具在老桥（协议 1.5）上给出"升级 jar"的教学话术', async () => {
  const { link } = makeLink({ responder: () => ({ ok: true }) })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.5' } } })
  await assert.rejects(find(tools, 'sirius_use_item').execute({}, {}), /需要 1\.6/)
  await assert.rejects(find(tools, 'sirius_baritone').execute({}, {}), /升级/)
})

test('sirius_inventory：模组物品同时给 id 与显示名，原版同名的只给 id', async () => {
  const { link } = makeLink({
    responder: () => ({
      in_game: true,
      selected: 0,
      slots: [
        { slot: 0, item: 'create:cogwheel', display: '齿轮', count: 4, role: 'hotbar' },
        { slot: 1, item: 'minecraft:oak_log', display: 'Oak Log', count: 12, role: 'hotbar' },
      ],
      counts: {},
    }),
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {} })
  const value = await find(tools, 'sirius_inventory').execute({}, {})
  assert.match(value.summary, /create:cogwheel（齿轮）/, `摘要：${value.summary}`)
  assert.match(value.summary, /minecraft:oak_log×12/, '原版同名不该被加了括号噪音')
  assert.ok(!/minecraft:oak_log（Oak Log）/.test(value.summary))
})

test('sirius_select：摘要带显示名', async () => {
  const { link } = makeLink({
    responder: () => ({ in_game: true, selected: 2, previous: 0, item: { name: 'create:cogwheel', display: '齿轮', count: 4 } }),
  })
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state: { capabilities: { protocol: '1.6' } } })
  const value = await find(tools, 'sirius_select').execute({ slot: 2 }, {})
  assert.match(value.summary, /create:cogwheel（齿轮）/)
})

test('sirius_status 把 ready 放进 summary', async () => {
  const tool = find(build(), 'sirius_status')
  const value = await tool.execute({}, {})
  assert.match(value.summary, /READY/)
  const notReady = find(createTools({
    ctx: { get: () => undefined },
    link: makeLink({ status: { ...READY, ready: false, screen: 'ChatScreen' } }).link,
    log: () => {},
  }), 'sirius_status')
  assert.match((await notReady.execute({}, {})).summary, /NOT-READY/)
})

/**
 * 命令文本序列：`#` 命令走 `chat.send`，`/` 命令走聊天栏（input.text）——
 * 两条通道都算"发出去的命令"，顺序按真实调用顺序。
 */
const textsOf = (calls) => calls
  .filter((c) => c.method === 'input.text' || c.method === 'chat.send')
  .map((c) => c.params.string)

/**
 * 带聊天栏状态机的假 link：按 T 打开、ENTER/ESC 关闭。
 * 真机里 `sendCommand` 就是靠 `getGuiState` 判断"聊天框到底开没开"（仅服务器命令走这条路）。
 */
function makeChatLink ({ position }) {
  const calls = []
  let screenOpen = false
  const link = {
    status: async () => READY,
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'getGuiState') {
        return screenOpen ? { screen_open: true, screen_class: 'ChatScreen' } : { screen_open: false }
      }
      if (method === 'input.key') {
        if (params.code === 84) screenOpen = true
        else if (params.code === 257 || params.code === 256) screenOpen = false
        return { ok: true }
      }
      if (method === 'getStats') return { in_game: true, position: position(), health: 20, yaw: 0 }
      return { ok: true }
    },
    subscribe: async (types) => ({ subscribed: true, types }),
    events: () => [],
    onEvent: () => () => {},
  }
  return { link, calls }
}

test('sirius_walk：baritone.goto → 按坐标位移判到位 → baritone.stop', async () => {
  const positions = [
    { x: 0, y: 64, z: 0 },
    { x: 3, y: 64, z: 0 },
    { x: 6, y: 64, z: 0 },
    { x: 9, y: 64, z: 0 },
    { x: 10, y: 64, z: 0 },
  ]
  let reads = 0
  const { link, calls } = makeChatLink({
    position: () => positions[Math.min(reads++, positions.length - 1)],
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 10, z: 0 }, {})
  assert.equal(value.data.result, 'arrived')
  assert.ok(calls.some((c) => c.method === 'baritone.goto' && c.params.x === 10 && c.params.z === 0))
  assert.ok(calls.some((c) => c.method === 'baritone.stop'))
  assert.match(value.summary, /到达/)
})

test('sirius_walk：同 X/Z 但 Y 不符不会误报 arrived', async () => {
  const { link } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 0, y: 30, z: 0, timeout_ms: 5000 }, {})
  assert.equal(value.data.result, 'no_progress')
  assert.notEqual(value.data.result, 'arrived')
})

test('sirius_walk：Baritone 自报 no_path → 结论是 no_path（不是"没装 Baritone"）', async () => {
  const { link } = makeBaritoneLink({ positions: [{ x: 0, y: 64, z: 0 }] })
  const withBaritone = {
    ...link,
    call: async (method, params = {}) => (method === 'baritone.status'
      ? { state: 'no_path', last_line: 'Unable to find a path', lines: ['Unable to find a path'] }
      : link.call(method, params)),
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link: withBaritone, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 100, z: 0, timeout_ms: 5000 }, {})
  assert.equal(value.data.result, 'no_path')
  assert.match(value.summary, /算不出/)
})

test('sirius_walk：一动不动 → no_progress（提示检查 Baritone）', async () => {  const { link, calls } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 100, z: 0, timeout_ms: 5000 }, {})
  assert.equal(value.data.result, 'no_progress')
  assert.match(value.summary, /Baritone/)
  const texts = textsOf(calls)
  assert.ok(calls.some((c) => c.method === 'baritone.stop'))
})

test('sirius_walk：取消时发 #stop 并抛错', async () => {
  const { link, calls } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 600)
  await assert.rejects(
    tool.execute({ x: 99, z: 0 }, { signal: controller.signal }),
    /取消/,
  )
  const texts = textsOf(calls)
  assert.ok(calls.some((c) => c.method === 'baritone.stop'))
})

// ---------------------------------------------------------------- 走路策略（默认不破坏 / 找门）

/**
 * Baritone 场景用的假桥：可控坐标序列 + world.query 方块表 + use 的返回。
 * `onUse` 在 use 被调用时触发，用来模拟「开门之后人终于动了」。
 */
function makeBaritoneLink ({ positions, blocks = [], useResult = { result: 'no_effect' }, onUse }) {
  const calls = []
  let reads = 0
  let screenOpen = false
  const link = {
    status: async () => READY,
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'getGuiState') return { screen_open: screenOpen, screen_class: screenOpen ? 'ChatScreen' : null }
      if (method === 'input.key') {
        if (params.code === 84) screenOpen = true
        else if (params.code === 257 || params.code === 256) screenOpen = false
        return { ok: true }
      }
      if (method === 'getStats') {
        const p = positions[Math.min(reads++, positions.length - 1)]
        return { in_game: true, position: p, health: 20 }
      }
      if (method === 'world.query') return { blocks }
      if (method === 'use') {
        onUse?.(params)
        return useResult
      }
      return { ok: true }
    },
    subscribe: async () => ({ subscribed: true }),
    events: () => [],
    onEvent: () => () => {},
  }
  return { link, calls }
}

test('sirius_walk：默认先关掉 Baritone 的破坏与放置，再调 goto', async () => {
  const { link, calls } = makeBaritoneLink({ positions: [{ x: 0, y: 64, z: 0 }] })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 40, z: 0, timeout_ms: 5000 }, {})
  assert.equal(value.data.result, 'no_progress')
  const settings = calls.find((c) => c.method === 'baritone.settings')
  assert.equal(settings.params.allow_break, false)
  assert.equal(settings.params.allow_place, false)
  const iBreak = calls.indexOf(settings)
  const iGoto = calls.findIndex((c) => c.method === 'baritone.goto')
  assert.ok(iBreak >= 0 && iGoto > iBreak, 'settings 应在 goto 之前')
  assert.equal(value.data.allow_break, false)
})

test('sirius_walk：allow_break=true 时放开破坏', async () => {
  const { link, calls } = makeBaritoneLink({ positions: [{ x: 0, y: 64, z: 0 }] })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  await tool.execute({ x: 40, z: 0, timeout_ms: 5000, allow_break: true }, {})
  assert.ok(calls.some((c) => c.method === 'baritone.settings' && c.params.allow_break === true))
  assert.ok(calls.some((c) => c.method === 'baritone.goto'
    && c.params.allow_break === true && c.params.allow_place === false),
  'goto 不得用默认 false 覆盖刚放行的设置')
})

test('sirius_walk：被挡住 + 打不开门 → blocked，并给出最近的门口坐标', async () => {
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_door' }
  const { link, calls } = makeBaritoneLink({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
    useResult: { result: 'no_effect' },
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 40, z: 0, timeout_ms: 9000 }, {})
  assert.equal(value.data.result, 'blocked')
  assert.equal(value.data.opened, 0)
  assert.equal(value.data.nearest_door.block, 'minecraft:oak_door')
  assert.match(value.summary, /被挡住/)
  assert.ok(calls.some((c) => c.method === 'baritone.stop'))
})

test('sirius_walk：卡住时用 use 开门，打开后继续走到位', async () => {
  let opened = false
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_fence_gate' }
  const { link, calls } = makeBaritoneLink({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
    useResult: { result: 'used', effect: 'block_changed' },
    onUse: () => { opened = true },
  })
  const instrumented = {
    ...link,
    call: async (method, params = {}) => {
      if (method === 'getStats' && opened) return { in_game: true, position: { x: 10, y: 64, z: 0 }, health: 20 }
      return link.call(method, params)
    },
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link: instrumented, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 10, z: 0, timeout_ms: 12000 }, {})
  assert.equal(value.data.result, 'arrived')
  assert.equal(value.data.opened, 1)
  assert.ok(calls.some((c) => c.method === 'use'), '卡住时应该调用 use 开门')
  assert.match(value.summary, /开了 1 扇门/)
})

test('sirius_walk：对端 bridge 没有 use（协议 <1.5）→ 跳过门兜底并在报文里说清', async () => {
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_door' }
  const { link, calls } = makeBaritoneLink({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
  })
  const state = {
    capabilities: { protocol: '1.4', hasUse: false },
    baritone: { allowBreak: null, allowPlace: null },
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {}, state }), 'sirius_walk')
  const value = await tool.execute({ x: 40, z: 0, timeout_ms: 9000 }, {})
  assert.equal(value.data.result, 'blocked')
  assert.ok(!calls.some((c) => c.method === 'use'), '老 jar 不该调用 use')
  assert.match(value.summary, /1\.5/)
})

test('sirius_walk：open_doors=false 时不试门，报文说明是主动关掉的', async () => {
  const door = { x: 3, y: 64, z: 0, block: 'minecraft:oak_door' }
  const { link, calls } = makeBaritoneLink({
    positions: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
    blocks: [door],
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_walk')
  const value = await tool.execute({ x: 40, z: 0, timeout_ms: 9000, open_doors: false }, {})
  assert.equal(value.data.result, 'blocked')
  assert.ok(!calls.some((c) => c.method === 'use'))
  assert.match(value.summary, /open_doors=false/)
})

function makeTunnelApiLink ({ position, result, reason, progress = 0 }) {
  const { link, calls } = makeChatLink({ position })
  const call = link.call
  link.call = async (method, params = {}) => {
    if (method === 'baritone.tunnel') {
      calls.push({ method, params })
      return { result: 'started', operation_id: 1 }
    }
    if (method === 'baritone.status') {
      calls.push({ method, params })
      return { state: 'pathing', tunnel: { operation_id: 1, active: false, result, reason, progress, direction: 'south' } }
    }
    return call(method, params)
  }
  return { link, calls }
}

test('sirius_tunnel：API 任务完成才报 done，并恢复安全寻路设置', async () => {
  const positions = [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 8 }]
  let reads = 0
  const { link, calls } = makeTunnelApiLink({
    position: () => positions[Math.min(reads++, positions.length - 1)],
    result: 'done', reason: 'region is air', progress: 8,
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_tunnel')
  const value = await tool.execute({ height: 2, width: 1, depth: 8 }, {})
  assert.equal(value.data.result, 'done')
  assert.equal(value.data.progress, 8)
  assert.equal(value.data.direction, 'south')
  assert.ok(calls.some((c) => c.method === 'baritone.tunnel'
    && c.params.height === 2 && c.params.width === 1 && c.params.depth === 8))
  assert.ok(!textsOf(calls).some((text) => text.startsWith('#mine')))
  const settings = calls.filter((c) => c.method === 'baritone.settings' && 'allow_break' in c.params)
  assert.equal(settings.at(-1).params.allow_break, false)
  assert.ok(calls.some((c) => c.method === 'baritone.settings' && c.params.allow_place === false))
})

test('sirius_tunnel：API 任务失败时返回 blocked 并恢复设置', async () => {
  const { link, calls } = makeTunnelApiLink({
    position: () => ({ x: 0, y: 64, z: 0 }), result: 'blocked', reason: 'Unable to do it',
  })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_tunnel')
  const value = await tool.execute({ height: 3, width: 2, depth: 6 }, {})
  assert.equal(value.data.result, 'blocked')
  assert.match(value.data.reason, /Unable to do it/)
  const settings = calls.filter((c) => c.method === 'baritone.settings' && 'allow_break' in c.params)
  assert.equal(settings.at(-1).params.allow_break, false)
})

test('sirius_tunnel：height 小于 2 时零副作用拒绝', async () => {
  const { link, calls } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_tunnel')
  await assert.rejects(tool.execute({ height: 1, width: 1, depth: 8 }, {}), /height/)
  assert.equal(textsOf(calls).length, 0)
})

// ---------------------------------------------------------------- 右键使用（sirius_use）

test('sirius_use：转发 use 参数，摘要里给出 result/证据/界面名', async () => {
  const calls = []
  const link = {
    status: async () => READY,
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'getGuiState') return { screen_open: false }
      if (method === 'getStats') return { in_game: true, position: { x: 0, y: 64, z: 0 }, health: 20 }
      if (method === 'use') {
        return {
          in_game: true,
          result: 'screen_opened',
          block: 'minecraft:crafting_table',
          face: 'up',
          hand: 'main',
          effect: 'screen',
          interaction: 'success',
          screen_class: 'CraftingScreen',
          elapsed_ms: 180,
        }
      }
      return { ok: true }
    },
    subscribe: async () => ({ subscribed: true }),
    events: () => [],
    onEvent: () => () => {},
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_use')
  const value = await tool.execute({ x: 10, y: 64, z: -20, face: 'up', hand: 'off' }, {})
  const sent = calls.find((call) => call.method === 'use')
  assert.deepEqual(sent.params, { x: 10, y: 64, z: -20, face: 'up', hand: 'off' })
  assert.equal(value.data.result, 'screen_opened')
  assert.match(value.summary, /screen_opened/)
  assert.match(value.summary, /CraftingScreen/)
  assert.match(value.summary, /interaction=success/)
})

test('sirius_use：不在世界里时直接拒（不惊动 bridge）', async () => {
  const link = {
    status: async () => ({ ...READY, inGame: false, ready: false }),
    call: async () => ({ ok: true }),
    subscribe: async () => ({ subscribed: true }),
    events: () => [],
    onEvent: () => () => {},
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_use')
  await assert.rejects(tool.execute({ x: 1, y: 2, z: 3 }, {}), /不在游戏/)
})

// ---------------------------------------------------------------- 键鼠（input.*）

function makeInputLink () {
  const calls = []
  const link = {
    status: async () => READY,
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'getGuiState') return { screen_open: true, screen_class: 'InventoryScreen' }
      if (method === 'input.mouseMove') {
        return { moved: true, x: params.x, y: params.y, gui_scaled: { x: params.x / 2, y: params.y / 2 } }
      }
      if (method === 'input.click') return { clicked: true, button: params.button, screen_open: true }
      if (method === 'input.key') return { injected: true, screen_open: true }
      if (method === 'input.text') return { delivered: params.string.length, codepoints: params.string.length, screen_open: true }
      return { ok: true }
    },
    subscribe: async () => ({}),
    events: () => [],
    onEvent: () => () => {},
  }
  return { link, calls }
}

test('sirius_key：键名/数字码都转成 GLFW 码，duration 与 modifiers 透传', async () => {
  const { link, calls } = makeInputLink()
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_key')

  await tool.execute({ code: 'E' }, {})
  assert.deepEqual(calls.at(-1), { method: 'input.key', params: { code: 69 } })

  await tool.execute({ code: '69' }, {})
  assert.deepEqual(calls.at(-1).params, { code: 69 })

  await tool.execute({ code: 'w', duration_ms: 500, modifiers: ['SHIFT'] }, {})
  assert.deepEqual(calls.at(-1).params, { code: 87, duration_ms: 500, modifiers: ['SHIFT'] })

  // 规则生成：任意字母/数字/功能键都要认识（真机踩过：Y 被拒）
  await tool.execute({ code: 'Y' }, {})
  assert.equal(calls.at(-1).params.code, 89)
  await tool.execute({ code: 'z' }, {})
  assert.equal(calls.at(-1).params.code, 90)
  await tool.execute({ code: 'F5' }, {})
  assert.equal(calls.at(-1).params.code, 294)
  await tool.execute({ code: 'F12' }, {})
  assert.equal(calls.at(-1).params.code, 301)

  // 模组热键场景：Alt+Y
  await tool.execute({ code: 'Y', modifiers: ['ALT'] }, {})
  assert.deepEqual(calls.at(-1).params, { code: 89, modifiers: ['ALT'] })

  await assert.rejects(tool.execute({ code: 'NOPE' }, {}), /不认识/)
})

test('sirius_type：转发 input.text，空串直接拒', async () => {
  const { link, calls } = makeInputLink()
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_type')
  const value = await tool.execute({ text: '你好 sirius' }, {})
  assert.deepEqual(calls.at(-1), { method: 'input.text', params: { string: '你好 sirius' } })
  assert.match(value.summary, /输入 9\/9/)
  await assert.rejects(tool.execute({ text: '' }, {}), /不能为空/)
})

test('sirius_click：给 at 时先探测缩放，再换算成窗口像素并校验落点', async () => {
  const { link, calls } = makeInputLink()
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_click')
  const value = await tool.execute({ at: { x: 88, y: 40 }, button: 'right' }, {})

  const moves = calls.filter((c) => c.method === 'input.mouseMove')
  assert.equal(moves.length, 2, '一次探测 + 一次真移动')
  assert.deepEqual(moves[1].params, { x: 176, y: 80 }, 'GUI 88,40 × scale 2 = 176,80')

  const clickCall = calls.find((c) => c.method === 'input.click')
  assert.deepEqual(clickCall.params, { button: 1, count: 1 })
  assert.match(value.summary, /GUI\(88, 40\)/)
})

test('sirius_click：落点不符时报"窗口可能未激活"', async () => {
  const link = {
    status: async () => READY,
    call: async (method) => {
      if (method === 'getGuiState') return { screen_open: true }
      if (method === 'input.mouseMove') return { moved: true, gui_scaled: { x: 10, y: 10 } }
      return { ok: true }
    },
    subscribe: async () => ({}),
    events: () => [],
    onEvent: () => () => {},
  }
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_click')
  await assert.rejects(tool.execute({ at: { x: 88, y: 40 } }, {}), /没落到预期位置|激活/)
})

test('sirius_click：不给 at 就点当前光标，hold_ms 与 count 互斥', async () => {
  const { link, calls } = makeInputLink()
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_click')
  await tool.execute({}, {})
  assert.deepEqual(calls.at(-1).params, { button: 0, count: 1 })

  await tool.execute({ hold_ms: 800 }, {})
  assert.deepEqual(calls.at(-1).params, { button: 0, hold_ms: 800 })
})

// ---------------------------------------------------------------- 后台走路 / 停止

function makeBgLink ({ position = () => ({ x: 0, y: 64, z: 0 }) } = {}) {
  const calls = []
  let screenOpen = false
  const link = {
    status: async () => ({ ...READY, position: position() }),
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'getGuiState') return { screen_open: screenOpen }
      if (method === 'input.key') {
        if (params.code === 84) screenOpen = true
        else if (params.code === 257 || params.code === 256) screenOpen = false
        return { ok: true }
      }
      if (method === 'getStats') return { in_game: true, position: position(), health: 20, yaw: 0 }
      if (method === 'world.query') return { blocks: [] }
      return { ok: true }
    },
    subscribe: async () => ({ subscribed: true }),
    events: () => [],
    onEvent: () => () => {},
  }
  return { link, calls }
}

test('sirius_walk { background: true }：立刻返回 started，并调用 baritone.goto', async () => {
  const { link, calls } = makeBgLink()
  const state = { capabilities: { hasUse: true }, baritone: { allowBreak: null, allowPlace: null }, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const walk = find(tools, 'sirius_walk')
  const value = await walk.execute({ x: 40, z: -8, background: true }, {})
  assert.equal(value.data.result, 'started')
  assert.match(value.data.walk_id, /^walk-/)
  assert.match(value.summary, /后台/)
  assert.ok(calls.some((c) => c.method === 'baritone.goto' && c.params.x === 40 && c.params.z === -8))
  assert.equal(state.walk.active, true)
  assert.equal(state.walk.snapshot().target.x, 40)
})

test('sirius_status：后台走路时把 ongoing 一起报出来', async () => {
  const { link } = makeBgLink()
  const state = { capabilities: { hasUse: true }, baritone: { allowBreak: null, allowPlace: null }, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  await find(tools, 'sirius_walk').execute({ x: 12, z: 3, background: true }, {})
  const value = await find(tools, 'sirius_status').execute({}, {})
  assert.ok(value.data.ongoing, '状态里应带 ongoing')
  assert.equal(value.data.ongoing.target.x, 12)
  assert.match(value.summary, /正在后台走/)
})

test('sirius_stop：注销后台走路并调用 baritone.stop，返回停稳位置', async () => {
  const { link, calls } = makeBgLink({ position: () => ({ x: 5, y: 64, z: 5 }) })
  const state = { capabilities: { hasUse: true }, baritone: { allowBreak: null, allowPlace: null }, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  await find(tools, 'sirius_walk').execute({ x: 80, z: 80, background: true }, {})
  const value = await find(tools, 'sirius_stop').execute({}, {})
  assert.equal(value.data.result, 'stopped_walk')
  assert.equal(state.walk.active, false)
  assert.ok(calls.some((c) => c.method === 'baritone.stop'))
  assert.match(value.summary, /停稳在/)
})

test('sirius_follow：默认半径 10，启动跟踪并可由 stop 停止', async () => {
  const { link, calls } = makeLink({
    responder: (method) => method === 'baritone.follow'
      ? { result: 'following', target: { uuid: 'p1', name: 'Steve', type: 'minecraft:player' } }
      : { ok: true },
  })
  const state = { capabilities: { protocol: '1.9' }, baritone: {}, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const value = await find(tools, 'sirius_follow').execute({ name: 'Steve' }, {})
  assert.deepEqual(calls.find((call) => call.method === 'baritone.follow').params, {
    name: 'Steve', follow_radius: 10, allow_break: false, allow_place: false,
  })
  assert.match(value.summary, /开始跟随 Steve/)
  assert.equal(state.follow.active, true)
  const stopped = await find(tools, 'sirius_stop').execute({}, {})
  assert.equal(stopped.data.result, 'stopped_follow')
  assert.equal(state.follow.active, false)
})

test('sirius_follow：agent 可调整半径与破坏设置', async () => {
  const { link, calls } = makeLink({
    responder: () => ({ result: 'following', target: { uuid: 'p1', name: 'Steve' } }),
  })
  const state = { capabilities: { protocol: '1.9' }, baritone: {}, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  await find(tools, 'sirius_follow').execute({ uuid: 'p1', follow_radius: 24, allow_break: true, allow_place: true }, {})
  assert.deepEqual(calls.at(-1).params, {
    uuid: 'p1', follow_radius: 24, allow_break: true, allow_place: true,
  })
})

test('sirius_follow：协议 1.8 时明确要求升级桥', async () => {
  const { link } = makeLink()
  const tools = createTools({
    ctx: { get: () => undefined }, link, log: () => {},
    state: { capabilities: { protocol: '1.8' }, baritone: {} },
  })
  await assert.rejects(find(tools, 'sirius_follow').execute({ name: 'Steve' }, {}), /需要 1\.9/)
})

// ---------------------------------------------------------------- 子代理权限收紧

function makeSubState (subId) {
  return {
    capabilities: { protocol: '1.5', hasUse: true },
    baritone: { allowBreak: null, allowPlace: null },
    notify: () => {},
    subagentIds: new Set([subId]),
  }
}

test('子代理没有说话权：sirius_say 直接拒', async () => {
  const { link } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const state = makeSubState('sub-1')
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const say = find(tools, 'sirius_say')
  await assert.rejects(
    say.execute({ text: '我来啦' }, { agent: { id: 'sub-1' } }),
    /没有说话权/,
  )
})

test('主代理照常能说话', async () => {
  const { link } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const state = makeSubState('sub-1')
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const value = await find(tools, 'sirius_say').execute({ text: '我来啦' }, { agent: { id: 'main-1' } })
  assert.match(value.summary, /已发送/)
})

test('子代理的命令只放 #stop/#pause/#resume，其它一律拒', async () => {
  const { link } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const state = makeSubState('sub-1')
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const command = find(tools, 'sirius_command')
  await assert.rejects(
    command.execute({ text: '/give @s minecraft:stone 8' }, { agent: { id: 'sub-1' } }),
    /子代理只能用/,
  )
  await assert.rejects(
    command.execute({ text: '#goto 100 100' }, { agent: { id: 'sub-1' } }),
    /子代理只能用/,
  )
  const ok = await command.execute({ text: '#stop' }, { agent: { id: 'sub-1' } })
  assert.match(ok.summary, /已发送命令/)
})

test('主代理发 /give 不受影响', async () => {
  const { link } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const state = makeSubState('sub-1')
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const value = await find(tools, 'sirius_command').execute(
    { text: '/give @s minecraft:stone 8' },
    { agent: { id: 'main-1' } },
  )
  assert.match(value.summary, /已发送命令/)
})

// ---------------------------------------------------------------- 命令分通道（# → chat.send，/ → 聊天栏）

test('sirius_command：`#` 命令走 chat.send，一个键都不按', async () => {
  const { link, calls } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_command')
  const value = await tool.execute({ text: '#goto 100 64 0' }, {})
  assert.ok(textsOf(calls).includes('#goto 100 64 0'))
  assert.ok(!calls.some((c) => c.method === 'input.key'), `不该按键：${calls.map((c) => c.method).join(' / ')}`)
  assert.equal(value.data.channel, 'chat.send')
  assert.match(value.summary, /进程内直发/)
})

test('sirius_command：`/` 服务器命令仍走聊天栏（T → 文本 → ENTER）', async () => {
  const { link, calls } = makeChatLink({ position: () => ({ x: 0, y: 64, z: 0 }) })
  const tool = find(createTools({ ctx: { get: () => undefined }, link, log: () => {} }), 'sirius_command')
  const value = await tool.execute({ text: '/give @s minecraft:stone 8' }, {})
  assert.ok(calls.some((c) => c.method === 'input.key'), '服务器命令必须按键开聊天栏')
  // channel 必须有值：以前这里留成 undefined，宿主判成"非无损 JSON"
  // → 报 "invalid output: value is not lossless JSON"，模型以为命令失败（2026-11-01 用户报）
  assert.equal(value.data.channel, 'chatbar')
  assert.ok(textsOf(calls).includes('/give @s minecraft:stone 8'))
})

test('chatControl 只关一次：连续两次走路不再重复发', async () => {
  const { link, calls } = makeBgLink()
  const state = { capabilities: { hasUse: true }, baritone: { allowBreak: null, allowPlace: null, chatControl: null }, notify: () => {} }
  const tools = createTools({ ctx: { get: () => undefined }, link, log: () => {}, state })
  const walk = find(tools, 'sirius_walk')
  await walk.execute({ x: 4, z: 0, background: true }, {})
  await walk.execute({ x: 8, z: 0, background: true }, {})
  const hits = calls.filter((c) => c.method === 'baritone.settings' && c.params.chat_control === false)
  assert.equal(hits.length, 1, 'chat_control=false 应只发一次')
  assert.notEqual(state.baritone.chatControl, null)
})

