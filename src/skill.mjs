import { readFileSync } from 'node:fs'

export const OFFICIAL_SKILL_NAME = 'sirius-builtins'
export const PLUGIN_DEVELOPMENT_SKILL_NAME = 'sirius-plugin-development'

export function registerOfficialSkill (ctx) {
  if (typeof ctx.skills?.register !== 'function') return false
  const source = readFileSync(new URL('../skills/sirius-builtins/SKILL.md', import.meta.url), 'utf8')
  const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  const dispose = ctx.skills.register({
    name: OFFICIAL_SKILL_NAME,
    description: 'Sirius 全部官方 core.* 插件的参数、示例、返回值与安全约束',
    whenToUse: '需要运行或编排 Sirius 内置 Minecraft 插件时',
    source: 'runtime',
    provider: 'sirius-for-whale',
    content,
  })
  ctx.effect(() => () => dispose(), 'sirius-for-whale: official skill')
  return true
}

export function registerPluginDevelopmentSkill (ctx) {
  if (typeof ctx.skills?.register !== 'function') return false
  const source = readFileSync(new URL('../skills/sirius-plugin-development/SKILL.md', import.meta.url), 'utf8')
  const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  const dispose = ctx.skills.register({
    name: PLUGIN_DEVELOPMENT_SKILL_NAME,
    description: 'Sirius 自定义插件开发、ctx API、事件、生命周期、嵌套编排与会话配置',
    whenToUse: '需要编写、调试或持久化 user.* 插件时',
    source: 'runtime',
    provider: 'sirius-for-whale',
    content,
  })
  ctx.effect(() => () => dispose(), 'sirius-for-whale: plugin development skill')
  return true
}
