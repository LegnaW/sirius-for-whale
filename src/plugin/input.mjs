export const SPECIAL = {
  ESC: 256, ENTER: 257, TAB: 258, SPACE: 32, BACKSPACE: 259, DELETE: 261,
  SHIFT: 340, LSHIFT: 340, RSHIFT: 344, CTRL: 341, LCTRL: 341, ALT: 342, SUPER: 343,
  UP: 265, DOWN: 264, LEFT: 263, RIGHT: 262,
  HOME: 268, END: 269, PAGEUP: 266, PAGEDOWN: 267, INSERT: 260,
  MINUS: 45, EQUAL: 61, COMMA: 44, PERIOD: 46, SLASH: 47, SEMICOLON: 59, APOSTROPHE: 39,
}

export function keyCode (value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('key 不能为空')
  if (/^\d+$/.test(raw)) return Number(raw)
  const upper = raw.toUpperCase()
  if (Object.hasOwn(SPECIAL, upper)) return SPECIAL[upper]
  if (upper.length === 1 && upper.charCodeAt(0) >= 65 && upper.charCodeAt(0) <= 90) return upper.charCodeAt(0)
  if (upper.length === 1 && upper.charCodeAt(0) >= 48 && upper.charCodeAt(0) <= 57) return upper.charCodeAt(0)
  const fn = /^F([1-9]|1[0-2])$/.exec(upper)
  if (fn) return 289 + Number(fn[1])
  throw new Error(`不支持的键名 ${raw}`)
}

export async function clickAt ({ call, click }) {
  const button = { left: 0, right: 1, middle: 2 }[click.button ?? 'left'] ?? 0
  if (click.at) {
    const probe = await call('input.mouseMove', { x: 100, y: 100 })
    const scale = 100 / probe?.gui_scaled?.x
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('无法测定 GUI 缩放')
    const x = Math.round(Number(click.at.x) * scale)
    const y = Math.round(Number(click.at.y) * scale)
    const moved = await call('input.mouseMove', { x, y })
    if (Math.abs(moved.gui_scaled.x - click.at.x) > 2 || Math.abs(moved.gui_scaled.y - click.at.y) > 2) {
      throw new Error(`鼠标未落到预期 GUI 坐标：${moved.gui_scaled.x},${moved.gui_scaled.y}`)
    }
  }
  if (click.count != null && click.hold_ms != null) throw new Error('count 与 hold_ms 互斥')
  const params = { button }
  if (click.hold_ms != null) params.hold_ms = click.hold_ms
  else params.count = click.count ?? 1
  return call('input.click', params)
}
