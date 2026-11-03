/**
 * 构造"非用户发言"的消息（宿主 `UserMessage` 形状）——看门狗唤醒用。
 * ============================================================================
 * 两条硬约束（whale_craft 在真机上踩出来的，这里直接沿用结论）：
 *   1. `source.kind` 必须是 **v4 规范值 `plugin:<插件名>`**（裸露的 'plugin' 会被
 *      会话格式拒绝），`form:'notice'` 让它渲染成折叠的一行摘要，而不是冒充用户发言。
 *   2. 宿主 `createUserMessage` 可能解析不到（它不是本插件的依赖），所以**宿主优先、
 *      拿不到用自带等价实现**，字段逐个对齐；否则会出现"工具都在、提示词全无"。
 * ============================================================================
 */
import { createRequire } from 'node:module'

export const SOURCE_KIND = 'plugin:sirius-for-whale'

const newMessageId = () => {
  try { return globalThis.crypto.randomUUID() } catch { /* 老 runtime */ }
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let hostCreateUserMessage = null
let loadNote = ''
try {
  const require = createRequire(import.meta.url)
  const mod = require('@deepseek-ai/dsh-llm')
  hostCreateUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null
  if (!hostCreateUserMessage) loadNote = '@deepseek-ai/dsh-llm 里没有 createUserMessage'
} catch (error) {
  loadNote = `解析不到 @deepseek-ai/dsh-llm（${error?.code ?? error?.message ?? error}）`
}

/** 诊断用：现在走的是宿主实现还是内置实现。 */
export const messageFactoryKind = () => (hostCreateUserMessage ? 'host' : 'builtin')
export const messageFactoryNote = () => loadNote

/**
 * 一条"插件提示"消息：折叠一行摘要 + 正文。
 * @param {string} text  正文（给模型看的完整内容）
 * @param {{ summary?: string }} [options]
 */
export function noticeMessage (text, { summary } = {}) {
  const input = {
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: summary ?? String(text).split('\n')[0].slice(0, 120),
    },
    id: newMessageId(),
  }
  if (typeof hostCreateUserMessage === 'function') {
    try { return hostCreateUserMessage(input) } catch { /* 宿主实现异常 → 用自带 */ }
  }
  return { role: 'user', content: input.content, source: input.source, id: input.id }
}
