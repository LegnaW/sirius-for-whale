import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BodyOwnership } from '../src/ownership.mjs'

test('挂载会话不会自动取得身体，init 激活后才可控制', () => {
  const ownership = new BodyOwnership()
  ownership.attach('a')
  ownership.attach('b')
  assert.equal(ownership.owner, null)
  assert.equal(ownership.canControl('a'), false)
  assert.equal(ownership.canControl('b'), false)

  assert.equal(ownership.activate('a'), 'a')
  assert.equal(ownership.owner, 'a')
  assert.equal(ownership.canControl('a'), true)
  assert.equal(ownership.canControl('b'), false)
})

test('旧会话再次 init 会接管，不向其它会话广播所有权', () => {
  const ownership = new BodyOwnership()
  ownership.attach('a')
  ownership.attach('b')
  ownership.activate('a')
  ownership.activate('b')
  assert.equal(ownership.owner, 'b')
  assert.equal(ownership.canControl('a'), false)
  assert.equal(ownership.canControl('b'), true)
  ownership.activate('a')
  assert.equal(ownership.owner, 'a')
})

test('子代理继承主会话所有权，主会话失去所有权后也被挡住', () => {
  const ownership = new BodyOwnership()
  ownership.attach('a')
  ownership.attach('b')
  ownership.attach('child-a', 'a')
  ownership.activate('a')
  assert.equal(ownership.canControl('child-a'), true)
  ownership.activate('b')
  assert.equal(ownership.canControl('child-a'), false)
})

test('所有者销毁后没有隐式继任者，其它会话必须显式 init', () => {
  const ownership = new BodyOwnership()
  ownership.attach('a')
  ownership.attach('b')
  ownership.activate('a')
  ownership.remove('a')
  assert.equal(ownership.owner, null)
  assert.equal(ownership.canControl('b'), false)
  ownership.activate('b')
  assert.equal(ownership.canControl('b'), true)
})
