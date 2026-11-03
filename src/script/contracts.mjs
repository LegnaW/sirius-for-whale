export const READ_METHODS = new Set([
  'getStats', 'getGuiState', 'world.query', 'inventory', 'players', 'block.get',
  'baritone.status', 'capabilities/list', 'chat.history',
])

const FILTER_KEYS = new Set(['types', 'uuid', 'entity_type', 'item', 'block', 'dimension'])
const FILTER_STRINGS = ['uuid', 'entity_type', 'item', 'block', 'dimension']

export function normalizeEventFilter (raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('事件订阅参数必须是对象')
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.has(key)) throw new Error(`不支持的事件过滤字段 ${key}`)
  }
  if (!Array.isArray(raw.types)) throw new Error('事件订阅 types 必须是字符串数组；空数组表示全部事件')
  if (raw.types.length > 32 || raw.types.some((type) => typeof type !== 'string' || !/^[a-z_*][a-z0-9_.*-]*$/.test(type))) {
    throw new Error('事件订阅 types 含非法名称，最多 32 项')
  }
  const filter = { types: [...new Set(raw.types)] }
  for (const key of FILTER_STRINGS) {
    if (raw[key] == null) continue
    if (typeof raw[key] !== 'string' || raw[key].length === 0 || raw[key].length > 256) {
      throw new Error(`事件过滤 ${key} 必须是非空字符串`)
    }
    filter[key] = raw[key]
  }
  return filter
}

function nestedValues (value, key, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return []
  const values = Object.hasOwn(value, key) ? [value[key]] : []
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      values.push(...nestedValues(child, key, depth + 1))
    }
  }
  return values
}

export function eventMatches (filter, record) {
  const types = filter?.types ?? []
  if (types.length > 0 && !types.includes('*') && !types.includes(record?.event)) return false
  const data = record?.data ?? {}
  if (filter.uuid && !nestedValues(data, 'uuid').includes(filter.uuid)) return false
  if (filter.entity_type && data.type !== filter.entity_type) return false
  if (filter.dimension && data.dimension !== filter.dimension) return false
  if (filter.item && !nestedValues(data, 'item').includes(filter.item)) return false
  if (filter.block && ![data.block, data.before?.block, data.after?.block].includes(filter.block)) return false
  return true
}

export function validateScriptInput ({ code, args, timeoutMs, defaultTimeoutMs, maxTimeoutMs, maxCodeBytes }) {
  if (typeof code !== 'string' || code.trim().length === 0) throw new Error('code 不能为空')
  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > maxCodeBytes) throw new Error(`脚本过大：${bytes} 字节，最多 ${maxCodeBytes}`)
  JSON.parse(JSON.stringify(args ?? {}))
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || (timeoutMs > 0 && timeoutMs < 100) || timeoutMs > maxTimeoutMs) {
    throw new Error(`timeout_ms 必须是 0（不限时）或 100..${maxTimeoutMs} 的整数`)
  }
  return { code, args: args ?? {}, timeoutMs: timeoutMs ?? defaultTimeoutMs }
}

export function activeStatus (record) {
  return record?.status === 'queued' || record?.status === 'running'
}
