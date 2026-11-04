import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerOfficialSkill, OFFICIAL_SKILL_NAME,
  registerPluginDevelopmentSkill, PLUGIN_DEVELOPMENT_SKILL_NAME,
} from '../src/skill.mjs'

test('官方 Skill 注册全部内置插件用法并可释放', () => {
  let definition = null
  let effect = null
  let disposed = false
  const registered = registerOfficialSkill({
    skills: { register: (value) => { definition = value; return () => { disposed = true } } },
    effect: (value) => { effect = value },
  })
  assert.equal(registered, true)
  assert.equal(definition.name, OFFICIAL_SKILL_NAME)
  for (const id of ['open_block', 'damage_watch', 'input', 'screenshot', 'walk', 'dig_to', 'follow', 'craft', 'attack', 'engage', 'tunnel']) {
    assert.ok(definition.content.includes(`core.${id}`), id)
  }
  assert.equal(definition.content.includes('---\nname:'), false)
  effect()()
  assert.equal(disposed, true)
})

test('插件开发 Skill 覆盖接口、事件、编排和配置并可释放', () => {
  let definition = null
  let effect = null
  let disposed = false
  const registered = registerPluginDevelopmentSkill({
    skills: { register: (value) => { definition = value; return () => { disposed = true } } },
    effect: (value) => { effect = value },
  })
  assert.equal(registered, true)
  assert.equal(definition.name, PLUGIN_DEVELOPMENT_SKILL_NAME)
  for (const text of ['ctx.api.call', 'ctx.events.subscribe', 'ctx.plugins.start', 'resume_checkpoint',
    'container_exchange', 'config/plugins.json', 'scripts/example/', 'block_update', 'slot_update']) {
    assert.ok(definition.content.includes(text), text)
  }
  assert.equal(definition.content.includes('---\nname:'), false)
  effect()()
  assert.equal(disposed, true)
})

test('宿主没有 Skill 服务时保持可选降级', () => {
  assert.equal(registerOfficialSkill({}), false)
  assert.equal(registerPluginDevelopmentSkill({}), false)
})
