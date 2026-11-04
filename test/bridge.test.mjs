import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BridgeLink, SiriusError } from '../src/bridge.mjs'
import { bridgeConnectionForGameDir } from '../src/config.mjs'
import { FakeWebSocket, serve } from '../support/fake-websocket.mjs'

const CONNECT = (handlers, options) => {
  FakeWebSocket.onConstruct = (ws) => {
    serve(ws, handlers, options)
    setTimeout(() => ws.open(), 0)
  }
}

beforeEach(() => FakeWebSocket.reset())

test('握手：hello → hello_ack 后 online 为真，protocol 透出', async () => {
  CONNECT({})
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  assert.equal(link.online, true)
  assert.equal(link.protocol, '1.4')
  assert.deepEqual(FakeWebSocket.last.sent[0], { type: 'hello', token: 't', protocol_version: '1.4' })
})

test('configure 在下一次连接使用指定实例的 URL 和 token 来源', async () => {
  CONNECT({})
  const link = new BridgeLink({ url: 'ws://old', token: 'old', WebSocketImpl: FakeWebSocket })
  link.configure({ url: 'ws://new', tokenCandidates: [{ token: 'new-token', path: 'mock/game/config/sirius_bridge.toml' }] })
  await link.connect()
  assert.equal(link.url, 'ws://new')
  assert.deepEqual(link.tokenSources, ['mock/game/config/sirius_bridge.toml'])
  assert.deepEqual(FakeWebSocket.last.sent[0], { type: 'hello', token: 'new-token', protocol_version: '1.4' })
})

test('game_dir 到 configure 全链路保留 tokenCandidates 并完成握手', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfw-init-connection-'))
  try {
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'sirius_bridge.toml'), 'port = 9123\ntoken = "init-token"\n')
    const override = bridgeConnectionForGameDir(dir)
    assert.equal(override.url, 'ws://127.0.0.1:9123')
    assert.equal(override.tokenCandidates.length, 1)
    CONNECT({})
    const link = new BridgeLink({ url: 'ws://old', tokenCandidates: [], WebSocketImpl: FakeWebSocket })
    link.configure(override)
    await link.connect()
    assert.equal(link.url, 'ws://127.0.0.1:9123')
    assert.equal(link.tokenSources.length, 1)
    assert.deepEqual(FakeWebSocket.last.sent[0], { type: 'hello', token: 'init-token', protocol_version: '1.4' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('token 被拒（close 1008）→ 抛带指引的错误', async () => {
  FakeWebSocket.onConstruct = (ws) => {
    ws.onSend = (frame, socket) => {
      if (frame.type === 'hello') setTimeout(() => socket.serverClose(1008, 'bad token'), 0)
    }
    setTimeout(() => ws.open(), 0)
  }
  const link = new BridgeLink({ url: 'ws://test', token: 'wrong', WebSocketImpl: FakeWebSocket })
  await assert.rejects(link.connect(), (error) => {
    assert.ok(error instanceof SiriusError)
    assert.match(error.message, /token|1008/)
    return true
  })
})

test('RPC 配对：并发请求按 id 各归各位（响应乱序也正确）', async () => {
  const handlers = {
    slow: async () => { await new Promise((r) => setTimeout(r, 30)); return { result: 'slow-ok' } },
    fast: async () => ({ result: 'fast-ok' }),
  }
  CONNECT(handlers)
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  const [slow, fast] = await Promise.all([link.call('slow'), link.call('fast')])
  assert.equal(slow, 'slow-ok')
  assert.equal(fast, 'fast-ok')
})

test('bridge 错误码映射为 SiriusError（保留 code/method）', async () => {
  CONNECT({ place: async () => ({ error: { code: -32602, message: 'place face must be one of up/down' } }) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await assert.rejects(link.call('place', { x: 1 }), (error) => {
    assert.equal(error.code, -32602)
    assert.equal(error.method, 'place')
    assert.match(error.message, /face must be one of/)
    return true
  })
})

test('超时：没有响应时按 timeoutMs 拒绝，并说明窗口最小化的坑', async () => {
  CONNECT({ hang: async () => new Promise(() => {}) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await assert.rejects(link.call('hang', {}, { timeoutMs: 60 }), (error) => {
    assert.match(error.message, /超时/)
    assert.match(error.hint ?? '', /最小化/)
    return true
  })
})

test('连接在请求中途关闭 → pending 全部拒绝', async () => {
  CONNECT({ hang: async () => new Promise(() => {}) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  const pending = link.call('hang', {}, { timeoutMs: 5_000 })
  await new Promise((r) => setTimeout(r, 30))
  FakeWebSocket.last.serverClose(1006, 'boom')
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof SiriusError)
    assert.match(error.message, /关闭|1006/)
    return true
  })
  assert.equal(link.online, false)
})

test('就绪判定：in_game 但 GUI 是 ReceivingLevelScreen → ready=false', async () => {
  CONNECT({
    getStats: async () => ({ result: { in_game: true, health: 20, food: 20, position: { x: 1, y: 64, z: 2 }, game_mode: 'creative' } }),
    getGuiState: async () => ({ result: { screen_open: true, screen_class: 'ReceivingLevelScreen' } }),
  })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  const status = await link.status()
  assert.equal(status.online, true)
  assert.equal(status.inGame, true)
  assert.equal(status.screen, 'ReceivingLevelScreen')
  assert.equal(status.ready, false)
})

test('就绪判定：在游戏里且无 GUI → ready=true', async () => {
  CONNECT({
    getStats: async () => ({ result: { in_game: true, health: 18.5, food: 17, position: { x: 1, y: 64, z: 2 }, game_mode: 'survival' } }),
    getGuiState: async () => ({ result: { screen_open: false } }),
  })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  const status = await link.status()
  assert.equal(status.ready, true)
  assert.equal(status.gameMode, 'survival')
})

test('未连接时 status 不抛错，返回 online:false', async () => {
  const link = new BridgeLink({ url: 'ws://test', token: '', WebSocketImpl: FakeWebSocket })
  // 让连接直接失败：不 open，交给超时
  const status = await link.status({ timeoutMs: 50 })
  assert.equal(status.online, false)
  assert.equal(status.ready, false)
})

test('事件：notification 进 ring 并按 seq 过滤；subscribe 幂等', async () => {
  CONNECT({ 'events.subscribe': async () => ({ result: { subscribed: true, types: ['chat'] } }) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  const ws = FakeWebSocket.last
  await link.subscribe(['chat'])
  await link.subscribe(['chat']) // 第二次不该再发
  const subscribeCalls = ws.sent.filter((f) => f.type === 'request' && f.method === 'events.subscribe')
  assert.equal(subscribeCalls.length, 1)

  ws.message({ type: 'notification', event: 'chat', data: { message: 'hi' }, timestamp: 1, seq: 0 })
  ws.message({ type: 'notification', event: 'chat', data: { message: 'yo' }, timestamp: 2, seq: 1 })
  assert.equal(link.events({ since: -1 }).length, 2)
  assert.equal(link.events({ since: 0, limit: 10 }).length, 1)
  assert.equal(link.events({ since: 0 })[0].data.message, 'yo')
})

test('ring 缓冲上限 200 条', async () => {
  CONNECT({})
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  const ws = FakeWebSocket.last
  for (let i = 0; i < 260; i += 1) {
    ws.message({ type: 'notification', event: 'chat', data: { message: String(i) }, timestamp: i, seq: i })
  }
  const rows = link.events({ since: -1, limit: 1000 })
  assert.equal(rows.length, 200)
  assert.equal(rows[rows.length - 1].data.message, '259')
})

test('多 token 候选：第一个被 1008 拒 → 自动换下一个并成功', async () => {
  let attempt = 0
  FakeWebSocket.onConstruct = (ws) => {
    attempt += 1
    ws.onSend = (frame, socket) => {
      if (frame.type !== 'hello') return
      // 只有正确 token 才 ack；第一次拿到的必然是错的那个 → 1008
      if (frame.token === 'right-token') {
        socket.message({ type: 'hello_ack', ok: true, protocol_version: '1.4' })
      } else {
        setTimeout(() => socket.serverClose(1008, 'token mismatch'), 0)
      }
    }
    setTimeout(() => ws.open(), 0)
  }
  const link = new BridgeLink({
    url: 'ws://test',
    WebSocketImpl: FakeWebSocket,
    tokenCandidates: [
      { token: 'wrong-token', path: 'mock/inst-a/config/sirius_bridge.toml' },
      { token: 'right-token', path: 'mock/inst-b/config/sirius_bridge.toml' },
    ],
  })
  const ack = await link.connect()
  assert.equal(ack.ok, true)
  assert.equal(attempt, 2)
  assert.equal(link.tokenSources.length, 2)
})

test('全部候选都被拒 → 报错里列出每个来源，而不是笼统的"token 不对"', async () => {
  FakeWebSocket.onConstruct = (ws) => {
    ws.onSend = (frame, socket) => {
      if (frame.type === 'hello') setTimeout(() => socket.serverClose(1008, 'token mismatch'), 0)
    }
    setTimeout(() => ws.open(), 0)
  }
  const link = new BridgeLink({
    url: 'ws://test',
    WebSocketImpl: FakeWebSocket,
    tokenCandidates: [
      { token: 'a', path: 'mock/inst-a/config/sirius_bridge.toml' },
      { token: 'b', path: 'mock/inst-b/config/sirius_bridge.toml' },
    ],
  })
  await assert.rejects(link.connect(), (error) => {
    assert.equal(error.code, 1008)
    assert.match(error.message, /inst-a/)
    assert.match(error.message, /inst-b/)
    assert.match(error.hint ?? '', /版本隔离/)
    return true
  })
})

test('一个候选都没有 → 立即失败，不发 hello（空 token 不该去撞 1008）', async () => {
  const before = FakeWebSocket.instances.length
  const link = new BridgeLink({ url: 'ws://test', WebSocketImpl: FakeWebSocket, tokenCandidates: [] })
  await assert.rejects(link.connect(), (error) => {
    assert.match(error.message, /没有可用|没有可用的 sirius-bridge token/)
    return true
  })
  assert.equal(FakeWebSocket.instances.length, before)
})

// 2026-11-01 真机事故的回归锚点：重启客户端后那条连接 2269 个请求里
// `events.subscribe` 一次都没有 → 喊不应、watchdog.received 冻住。
test('重连后必须重发 events.subscribe（订阅是连接级的）', async () => {
  CONNECT({ 'events.subscribe': async () => ({ result: { subscribed: true, types: ['chat'] } }) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  const first = FakeWebSocket.last
  await link.subscribe(['chat'])
  assert.equal(first.sent.filter((f) => f.type === 'request' && f.method === 'events.subscribe').length, 1)

  first.message({ type: 'notification', event: 'chat', data: { message: 'old' }, timestamp: 1, seq: 0 })
  assert.equal(link.events({ since: -1 }).length, 1)

  // 客户端重启 / 网络断一下
  first.serverClose(1006, 'mc restart')
  assert.equal(link.online, false)
  assert.deepEqual(link.subscribed, [], '旧连接的订阅不能算数')
  assert.equal(link.events({ since: -1 }).length, 0, '旧连接的 seq 必须清掉，否则 since 过滤全空')

  await link.connect()
  const second = FakeWebSocket.last
  assert.notEqual(second, first)
  await new Promise((r) => setTimeout(r, 10)) // #resubscribe 是后台发的
  const subs = second.sent.filter((f) => f.type === 'request' && f.method === 'events.subscribe')
  assert.equal(subs.length, 1)
  assert.deepEqual(subs[0].params.types, ['chat'])
  assert.deepEqual(link.subscribed, ['chat'])
})

test('subscribe 的"想要集合"跨连接保留：重连后一次发齐全部种类', async () => {
  CONNECT({ 'events.subscribe': async () => ({ result: { subscribed: true } }) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  await link.subscribe(['chat'])
  await link.subscribe(['death', 'gui_open'])
  FakeWebSocket.last.serverClose(1006, 'boom')
  await link.connect()
  await new Promise((r) => setTimeout(r, 10))
  const subs = FakeWebSocket.last.sent.filter((f) => f.method === 'events.subscribe')
  assert.equal(subs.length, 1)
  assert.deepEqual([...subs[0].params.types].sort(), ['chat', 'death', 'gui_open'])
})

test('sirius_init reset：作废旧连接和事件，重连后恢复想要的订阅', async () => {
  CONNECT({ 'events.subscribe': async () => ({ result: { subscribed: true } }) })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  const first = FakeWebSocket.last
  await link.subscribe(['chat'])
  first.message({ type: 'notification', event: 'chat', data: { message: 'old' }, timestamp: 1, seq: 0 })
  assert.equal(link.events({ since: -1 }).length, 1)

  await link.reset('sirius_init')
  assert.equal(link.online, false)
  assert.equal(link.events({ since: -1 }).length, 0)
  assert.deepEqual(link.subscribed, [])

  await link.connect()
  const second = FakeWebSocket.last
  assert.notEqual(second, first)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const subs = second.sent.filter((frame) => frame.method === 'events.subscribe')
  assert.equal(subs.length, 1)
  assert.deepEqual(subs[0].params.types, ['chat'])
})

test('init 后旧 socket 的延迟 close 不得清理新连接或拒绝新 RPC', async () => {
  let releaseStats = null
  CONNECT({
    'events.subscribe': async () => ({ result: { subscribed: true } }),
    getStats: () => new Promise((resolve) => {
      releaseStats = () => resolve({ in_game: false })
    }),
  })
  const link = new BridgeLink({ url: 'ws://test', token: 't', WebSocketImpl: FakeWebSocket })
  await link.connect()
  const first = FakeWebSocket.last
  await link.reset('sirius_init')
  await link.connect()
  const second = FakeWebSocket.last
  assert.notEqual(second, first)

  const pending = link.call('getStats', {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(typeof releaseStats, 'function')
  first.serverClose(1000, 'delayed normal closure')
  releaseStats()
  const result = await pending
  assert.equal(result.in_game, false)
  assert.equal(link.online, true)
})
