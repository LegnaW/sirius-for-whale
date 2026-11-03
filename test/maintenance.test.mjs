import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBridgeMaintenanceTick } from '../src/maintenance.mjs'

function fixture ({ online, subscribed = true }) {
  const calls = []
  const bridgeCache = {
    capabilities: { protocol: '1.7', hasUse: true },
    baritone: { allowBreak: true, allowPlace: true, chatControl: true },
  }
  let subscription = subscribed
  const tick = createBridgeMaintenanceTick({
    link: {
      status: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return { online, protocol: online ? '1.8' : null }
      },
    },
    bridgeCache,
    getSubscribed: () => subscription,
    setSubscribed: (value) => { subscription = value },
    ensureSubscribed: () => { calls.push('subscribe') },
    probeCapabilities: () => { calls.push('probe') },
    refreshSelf: () => { calls.push('refreshSelf') },
    tickAutonomy: async () => { calls.push('autonomy') },
  })
  return { tick, calls, bridgeCache, getSubscribed: () => subscription }
}

test('维护 tick 等待异步在线状态，并执行在线维护与自主节律', async () => {
  const { tick, calls, bridgeCache } = fixture({ online: true })
  await tick()
  assert.equal(bridgeCache.capabilities.protocol, '1.8')
  assert.deepEqual(calls, ['probe', 'refreshSelf', 'autonomy'])
})

test('离线 tick 清空连接级缓存', async () => {
  const current = fixture({ online: false })
  await current.tick()
  assert.equal(current.getSubscribed(), false)
  assert.deepEqual(current.bridgeCache, {
    capabilities: { protocol: null, hasUse: null },
    baritone: { allowBreak: null, allowPlace: null, chatControl: null },
  })
  assert.deepEqual(current.calls, [])
})

test('重连后的未订阅状态会重新订阅，并恢复自主节律', async () => {
  const { tick, calls } = fixture({ online: true, subscribed: false })
  await tick()
  assert.deepEqual(calls, ['probe', 'subscribe', 'autonomy'])
})
