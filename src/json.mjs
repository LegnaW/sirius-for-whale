/**
 * 无损 JSON：宿主对**工具返回值**的硬要求。
 * ============================================================================
 * 🔴 2026-11-01 真机（用户报）："经常返回命令执行失败，但实际上执行成功了"，
 *    报错是 `invalid output: value is not lossless JSON`。
 *
 * 原因：宿主把工具 `execute()` 解析出的值当成 JsonValue 校验。只要里面出现
 *   · `undefined`（最隐蔽：`{ channel: undefined }` 这种"可选字段没赋上"）
 *   · `NaN` / `±Infinity`（算术失败、除零）
 *   · `bigint`、函数、Symbol
 *   · 循环引用
 * 整次调用就会被判为"输出非法"——**但动作早就执行完了**，于是模型看到的是
 * "失败"，世界里却是"成功"。这种假失败最浪费时间：模型会重试，重复执行。
 *
 * 所以每个工具的返回值统一过一遍 `toLosslessJSON`：
 *   · 对象里 `undefined` 的键**直接删掉**（不是变成 null，少给模型噪音）
 *   · 数组里的 `undefined` 变 `null`（保持下标不塌陷）
 *   · `NaN`/`Infinity` 变 `null`（JSON 没有这两个值）
 *   · `bigint` 变字符串，函数/Symbol 丢掉，循环引用处丢掉
 * ============================================================================
 */
export function toLosslessJSON (value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  // JSON 只有有限双精度数：NaN / ±Infinity 一律降级成 null；
  // -0 也归一成 0（它 stringify 成 "0"，strict 的往返校验会判"不无损"）
  if (type === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (type === 'bigint') return String(value)
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (type !== 'object') return undefined

  if (seen.has(value)) return undefined // 循环引用：在第一次出现的地方已经展开了
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const next = toLosslessJSON(item, seen)
        return next === undefined ? null : next
      })
    }
    if (typeof value.toJSON === 'function') {
      try { return toLosslessJSON(value.toJSON(), seen) } catch { return null }
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const next = toLosslessJSON(item, seen)
      if (next !== undefined) out[key] = next
    }
    return out
  } finally {
    seen.delete(value)
  }
}
