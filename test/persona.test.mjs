import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PERSONA, createPersonaLoader } from '../src/persona.mjs'

function fakeFs (initialText, { missing = false } = {}) {
  const state = { text: initialText, mtimeMs: 1000, missing }
  return {
    state,
    statSync () {
      if (state.missing) {
        const error = new Error('no such file')
        error.code = 'ENOENT'
        throw error
      }
      return { mtimeMs: state.mtimeMs }
    },
    readFile () {
      return state.text
    },
    write (text) {
      state.text = text
      state.mtimeMs += 1
    },
  }
}

test('读文件：内容被 trim 后作为人设，来源标出路径', () => {
  const fs = fakeFs('\n  你是一个测试人设。\n\n')
  const load = createPersonaLoader({ file: '/x/persona.txt', ...fs })
  const result = load()
  assert.equal(result.text, '你是一个测试人设。')
  assert.equal(result.source, '/x/persona.txt')
})

test('热加载：文件改了以后同名加载器会重读（按 mtime）', () => {
  const fs = fakeFs('第一版人设')
  const load = createPersonaLoader({ file: '/x/persona.txt', ...fs })
  assert.equal(load().text, '第一版人设')
  assert.equal(load().text, '第一版人设', 'mtime 没变就不重读')
  fs.write('第二版人设')
  assert.equal(load().text, '第二版人设', 'mtime 变了应重读')
})

test('文件不存在 → 回退内置默认（插件不会失去身份）', () => {
  const fs = fakeFs('', { missing: true })
  const load = createPersonaLoader({ file: '/x/nope.txt', ...fs })
  const result = load()
  assert.equal(result.text, DEFAULT_PERSONA)
  assert.match(result.source, /内置默认/)
  assert.match(result.source, /ENOENT/)
})

test('空文件 → 也用内置默认', () => {
  const fs = fakeFs('   \n\n')
  const load = createPersonaLoader({ file: '/x/persona.txt', ...fs })
  assert.equal(load().text, DEFAULT_PERSONA)
  assert.match(load().source, /空文件/)
})

test('内联配置优先于文件', () => {
  const fs = fakeFs('文件里的话')
  const load = createPersonaLoader({ file: '/x/persona.txt', inline: '  配置里的话  ', ...fs })
  const result = load()
  assert.equal(result.text, '配置里的话')
  assert.match(result.source, /内联/)
})

test('没给 file 也没给 inline → 内置默认', () => {
  const load = createPersonaLoader({})
  assert.equal(load().text, DEFAULT_PERSONA)
})

test('默认人设不含未注册的 {{变量}}（插值关闭，避免渲染失败）', () => {
  assert.ok(!DEFAULT_PERSONA.includes('{{'), '默认人设里不应出现 {{...}}')
})
