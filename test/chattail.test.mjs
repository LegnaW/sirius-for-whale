import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createChatTail, formatChatTail, formatRecentChat, maxSeqOf, pickNewChats } from '../src/chattail.mjs'

const row = (seq, message, extra = {}) => ({ seq, event: 'chat', data: { message, ...extra } })

test('pickNewChats：只取游标之后的新行，按时间升序', () => {
  const rows = [row(1, '<A> 旧一句'), row(2, '<A> 第二句'), row(3, '<B> 第三句')]
  const { lines, nextSeq } = pickNewChats(rows, 1, { max: 5 })
  assert.deepEqual(lines, ['<A> 第二句', '<B> 第三句'])
  assert.equal(nextSeq, 3)
})

test('pickNewChats：超过 max 只留最后几条（新的更重要）', () => {
  const rows = [1, 2, 3, 4, 5].map((seq) => row(seq, `<A> 第${seq}句`))
  const { lines } = pickNewChats(rows, 0, { max: 3 })
  assert.deepEqual(lines, ['<A> 第3句', '<A> 第4句', '<A> 第5句'])
})

test('pickNewChats：系统消息与非 chat 事件不要', () => {
  const rows = [
    row(1, 'Steve joined the game', { system: true }),
    { seq: 2, event: 'health_low', data: { health: 6 } },
    row(3, '<A> 真聊天'),
  ]
  assert.deepEqual(pickNewChats(rows, 0).lines, ['<A> 真聊天'])
})

test('pickNewChats：自己的发言不回灌', () => {
  const rows = [row(1, '<Sirius> 我到了'), row(2, '<A> 好')]
  assert.deepEqual(pickNewChats(rows, 0, { selfName: 'Sirius' }).lines, ['<A> 好'])
})

test('pickNewChats：游标推进到环里最大 seq（含被过滤掉的行），不会重复贴', () => {
  const rows = [row(5, '<A> 系统之外的'), row(6, '公告', { system: true })]
  const first = pickNewChats(rows, 0, { max: 3 })
  assert.deepEqual(first.lines, ['<A> 系统之外的'])
  assert.equal(first.nextSeq, 6)
  const second = pickNewChats(rows, first.nextSeq, { max: 3 })
  assert.deepEqual(second.lines, [], '同一批不该再出现一次')
})

test('maxSeqOf：空环/异常输入都安全', () => {
  assert.equal(maxSeqOf([]), 0)
  assert.equal(maxSeqOf(null), 0)
  assert.equal(maxSeqOf([row(3, 'a'), { seq: 9 }]), 9)
})

test('createChatTail：take 两次只给一次增量', () => {
  const rows = [row(1, '<A> 一'), row(2, '<A> 二')]
  const tail = createChatTail({ fetchRows: () => rows, max: 3 })
  assert.deepEqual(tail.take(), ['<A> 一', '<A> 二'])
  assert.deepEqual(tail.take(), [])
  rows.push(row(3, '<A> 三'))
  assert.deepEqual(tail.take(), ['<A> 三'])
})

test('createChatTail：init 重置后接受新连接从 0 开始的 seq', () => {
  let rows = [row(100, '<A> 旧连接')]
  const tail = createChatTail({ fetchRows: () => rows })
  assert.deepEqual(tail.take(), ['<A> 旧连接'])
  tail.reset()
  rows = [row(1, '<B> 新连接')]
  assert.deepEqual(tail.take(), ['<B> 新连接'])
})

test('createChatTail：markDelivered 之后不再重复（看门狗已贴过）', () => {
  const rows = [row(1, '<A> 喊我'), row(2, '<A> 又一句')]
  const tail = createChatTail({ fetchRows: () => rows })
  tail.markDelivered()
  assert.deepEqual(tail.take(), [])
  rows.push(row(3, '<A> 新的'))
  assert.deepEqual(tail.take(), ['<A> 新的'])
})

test('createChatTail：取事件环抛错时安静返回空', () => {
  const tail = createChatTail({ fetchRows: () => { throw new Error('boom') } })
  assert.deepEqual(tail.take(), [])
})

test('formatChatTail：拼成一行；空数组返回 null', () => {
  assert.equal(formatChatTail([]), null)
  assert.equal(formatChatTail(null), null)
  assert.equal(formatChatTail(['<A> 一', '<B> 二']), '〔近聊〕<A> 一 ｜ <B> 二')
})

// ---------------------------------------------------------------- 唤醒报文里的〔近期聊天〕

test('formatRecentChat：按时间升序、最多 max 条，最后一行最新', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((seq) => row(seq, `<A> 第${seq}句`))
  const text = formatRecentChat(rows, { max: 3 })
  assert.match(text, /〔近期聊天〕/)
  assert.match(text, /<A> 第5句/)
  assert.match(text, /<A> 第7句/)
  assert.ok(!text.includes('第4句'), '超出 max 的不该出现')
  const lines = text.split('\n').slice(1)
  assert.equal(lines.at(-1), '· <A> 第7句')
})

test('formatRecentChat：正文里已有的那句不重复（触发它的那条）', () => {
  const rows = [row(1, '<A> 早的'), row(2, '<PlayerA> 在吗')]
  const text = formatRecentChat(rows, { avoid: '〔有人喊我〕<PlayerA> 在吗' })
  assert.match(text, /早的/)
  assert.ok(!text.includes('<PlayerA> 在吗'))
})

test('formatRecentChat：连着的重复只留一次；空聊天返回 null', () => {
  const rows = [row(1, '<A> 同一句'), row(2, '<A> 同一句'), row(3, '<B> 另一句')]
  const text = formatRecentChat(rows)
  assert.equal(text.split('同一句').length - 1, 1)
  assert.match(text, /另一句/)
  assert.equal(formatRecentChat([]), null)
  assert.equal(formatRecentChat([{ seq: 1, event: 'chat', data: {} }]), null)
})

test('formatRecentChat：系统消息（进服/死亡）也带上，它们是上下文', () => {
  const rows = [row(1, 'Steve joined the game', { system: true }), row(2, '<A> 你来了')]
  const text = formatRecentChat(rows)
  assert.match(text, /Steve joined the game/)
})
