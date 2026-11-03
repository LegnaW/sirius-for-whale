import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toLosslessJSON } from '../src/json.mjs'

// 宿主把工具返回值当 JsonValue 校验，一旦出现下面这些就报
// `invalid output: value is not lossless JSON`——而动作其实已经做完了（2026-11-01 用户报）。

test('undefined 的对象键直接删掉（不是变成 null）', () => {
  const out = toLosslessJSON({ sent: 'x', channel: undefined, closed: true })
  assert.deepEqual(out, { sent: 'x', closed: true })
  assert.ok(!('channel' in out))
})

test('NaN / ±Infinity → null（JSON 没有这三个值）', () => {
  assert.deepEqual(toLosslessJSON({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY }), {
    a: null, b: null, c: null,
  })
})

test('-0 归一成 0（它 stringify 成 "0"，往返校验会判成不无损）', () => {
  const out = toLosslessJSON({ x: -0 })
  assert.ok(Object.is(out.x, 0))
  assert.ok(!Object.is(out.x, -0))
})

test('数组里的 undefined 变 null，下标不塌陷', () => {
  assert.deepEqual(toLosslessJSON([1, undefined, 3]), [1, null, 3])
})

test('嵌套结构与 bigint / 函数 / symbol', () => {
  const out = toLosslessJSON({
    list: [{ ok: true, why: undefined }],
    big: 10n,
    fn: () => 1,
    sym: Symbol('s'),
  })
  assert.deepEqual(out, { list: [{ ok: true }], big: '10' })
})

test('循环引用不会炸，也不会无限递归', () => {
  const node = { name: 'a' }
  node.self = node
  const out = toLosslessJSON(node)
  assert.deepEqual(out, { name: 'a' })
})

test('普通值原样返回', () => {
  assert.equal(toLosslessJSON(null), null)
  assert.equal(toLosslessJSON('x'), 'x')
  assert.equal(toLosslessJSON(0), 0)
  assert.equal(toLosslessJSON(false), false)
  assert.deepEqual(toLosslessJSON({ a: [1, { b: 2 }] }), { a: [1, { b: 2 }] })
})

test('有 toJSON 的对象用它（Date 之类）', () => {
  const date = new Date('2026-11-01T00:00:00Z')
  assert.equal(toLosslessJSON({ at: date }).at, date.toJSON())
})
