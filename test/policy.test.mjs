import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SIRIUS_DENY, SUB_TOOLS } from '../src/plugin.mjs'
import { TOOL_NAMES } from '../src/tools.mjs'

test('Sirius 主会话：黑名单只保留 shell 和插件管理', () => {
  assert.deepEqual(SIRIUS_DENY, ['bash', 'pwsh', 'plugin_manager'])
})

test('Sirius 主会话：游戏、skill、Web、Soul、文件与协作工具默认放行', () => {
  for (const name of [
    ...TOOL_NAMES,
    'skill', 'web_fetch', 'web_search', 'soul_recall', 'soul_expand',
    'read', 'read_image', 'write', 'edit', 'glob', 'grep',
    'todo_write', 'job_list', 'job_output', 'job_kill',
    'subagent', 'send_message', 'interrupt_agent', 'list_agents',
  ]) {
    assert.ok(!SIRIUS_DENY.includes(name), `${name} 不应出现在 SIRIUS_DENY`)
  }
})

test('子代理：有腿有眼，没有嘴、没有文件写、没有派活', () => {
  for (const name of ['sirius_walk', 'sirius_dig', 'sirius_use', 'sirius_screenshot', 'read_image']) {
    assert.ok(SUB_TOOLS.includes(name), `子代理应有 ${name}`)
  }
  for (const name of ['sirius_say', 'subagent', 'send_message', 'interrupt_agent', 'write', 'edit', 'read']) {
    assert.ok(!SUB_TOOLS.includes(name), `子代理不该有 ${name}`)
  }
})

test('子代理：命令工具在表里但由工具层收紧到 #stop/#pause/#resume', () => {
  assert.ok(SUB_TOOLS.includes('sirius_command'))
})
