/**
 * 近聊尾巴：**动作类工具返回时，顺带贴上"你干活期间新出现的聊天"。**
 * ============================================================================
 * 用户的点子（2026-10-31）：机器人每执行完一段任务就返回最近的聊天栏，这样它不必
 * 专门去查也能知道刚才发生了什么。
 *
 * 但直接"每次贴最近 N 条"有两个真实代价：
 *   1. **工具结果会进历史**，每轮都被重复读。贴全量 = 几轮后历史全是旧聊天，
 *      既烧 token 又会让模型把老消息当成新消息。
 *   2. 看门狗唤醒时已经把这几条贴过一次了，再贴 = 同一句话出现两遍。
 *
 * 所以这里的规矩是**只给增量**：
 *   · 用一个游标（`seq`）记住"已经给过模型到哪一条"，只贴此后的新行；
 *   · 最多 `max` 条（默认 3），越界就只贴最后几条（新的更重要）；
 *   · 自己的发言不回灌（`selfName` 前缀过滤）；
 *   · 看门狗唤醒时调 `markDelivered()`，把那之前的行标成"已给过"。
 * ============================================================================
 */

/** 从事件环里挑出"比游标新"的聊天行。纯函数，单测直接喂数组。 */
export function pickNewChats (rows, sinceSeq, { max = 3, selfName = null } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const newestFirst = list
    .filter((row) => row?.event === 'chat')
    .filter((row) => Number(row.seq ?? 0) > sinceSeq)
    .filter((row) => row?.data?.system !== true)
    .filter((row) => {
      if (!selfName) return true
      const message = String(row?.data?.message ?? '')
      return !message.startsWith(`<${selfName}>`)
    })
    .sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0))
  const picked = newestFirst.slice(-max)
  const nextSeq = list.reduce((maxSeq, row) => Math.max(maxSeq, Number(row?.seq ?? 0)), sinceSeq)
  return {
    lines: picked.map((row) => String(row?.data?.message ?? '')).filter(Boolean),
    nextSeq,
  }
}

/** 事件环里最大的 seq（用于"这些已经给过模型了"）。 */
export function maxSeqOf (rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (maxSeq, row) => Math.max(maxSeq, Number(row?.seq ?? 0)),
    0,
  )
}

/**
 * 近聊游标。
 * @param {object} options
 * @param {() => Array} options.fetchRows 取事件环（一般传 link.events）
 * @param {() => string|null} [options.selfName] 自己的名字（过滤自说自话）
 * @param {number} [options.max]
 */
export function createChatTail ({ fetchRows, selfName = () => null, max = 3 } = {}) {
  let cursor = 0
  return {
    /** 取走"还没给过"的聊天行（并推进游标）；没有新的就返回空数组。 */
    take () {
      let rows
      try {
        rows = fetchRows() ?? []
      } catch {
        return []
      }
      const { lines, nextSeq } = pickNewChats(rows, cursor, { max, selfName: selfName() })
      cursor = nextSeq
      return lines
    },
    /** 看门狗已经把这些贴给模型了 → 标记为已给过，避免重复。 */
    markDelivered () {
      try {
        cursor = Math.max(cursor, maxSeqOf(fetchRows() ?? []))
      } catch { /* 拿不到就算了 */ }
    },
    reset () { cursor = 0 },
    get cursor () { return cursor },
  }
}

/** 拼成一行，挂在工具结果末尾。 */
export function formatChatTail (lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null
  return `〔近聊〕${lines.join(' ｜ ')}`
}

/**
 * 〔近期聊天〕块：**任何一次唤醒都附上**（用户2026-10-31："无论何时被触发都附上近期聊天记录"）。
 * ============================================================================
 * 跟 {@link pickNewChats} 的分工：
 *   · `pickNewChats` = **增量**，贴在工具结果末尾（干活期间新冒出来的），只给一次；
 *   · 这个 = **快照**，挂在唤醒报文里（"你被叫醒的那一刻，周围在聊什么"），
 *     自主时间、观察汇报、走路到达这些没有触发聊天时，它就是唯一的对话上下文。
 *
 * 正文里已经写过的那句（触发这次唤醒的那条）不再重复：`avoid` 传正文即可。
 * 同一句话连着出现也只留一次（服务器/模组有时会回声两遍）。
 * ============================================================================
 */
export function formatRecentChat (rows, { max = 6, avoid = '' } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.event === 'chat')
    .sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0))
  const lines = []
  for (const row of list) {
    const message = String(row?.data?.message ?? '').trim()
    if (!message) continue
    if (avoid && avoid.includes(message)) continue
    if (lines[lines.length - 1] === message) continue
    lines.push(message)
  }
  const tail = lines.slice(-Math.max(1, max))
  if (tail.length === 0) return null
  return ['〔近期聊天〕（最新在最后）', ...tail.map((line) => `· ${line}`)].join('\n')
}
