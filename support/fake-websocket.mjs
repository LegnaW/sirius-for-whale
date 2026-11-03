/**
 * 测试替身：一个可控的 WebSocket 实现 + RPC 应答器。
 * 目的：在**不开游戏**的情况下覆盖握手、RPC 配对、错误映射、超时、就绪判定。
 */
export class FakeWebSocket extends EventTarget {
  static instances = []
  /** 构造钩子（测试里给每个实例装 onSend / 自动握手）。 */
  static onConstruct = null

  static reset () {
    FakeWebSocket.instances = []
    FakeWebSocket.onConstruct = null
  }

  static get last () {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  }

  constructor (url) {
    super()
    this.url = url
    this.readyState = 0
    this.sent = []
    this.onSend = null
    FakeWebSocket.instances.push(this)
    FakeWebSocket.onConstruct?.(this)
  }

  // ---- 客户端侧 API（被测代码调用）
  send (raw) {
    const frame = JSON.parse(raw)
    this.sent.push(frame)
    this.onSend?.(frame, this)
  }

  close () {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
  }

  // ---- 测试侧驱动
  open () {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  message (frame) {
    this.dispatchEvent(Object.assign(new Event('message'), {
      data: typeof frame === 'string' ? frame : JSON.stringify(frame),
    }))
  }

  serverClose (code = 1006, reason = '') {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }
}

/**
 * 让桥"自动上线"：hello → hello_ack；request → 调用 handlers 里的方法。
 * handlers 返回值：`{ result }` 或 `{ error: {code, message} }`；也可以返回 Promise。
 */
export function serve (ws, handlers = {}, { protocol = '1.4' } = {}) {
  ws.onSend = async (frame, socket) => {
    if (frame.type === 'hello') {
      socket.message({ type: 'hello_ack', ok: true, protocol_version: protocol })
      return
    }
    if (frame.type === 'request') {
      const handler = handlers[frame.method]
      if (!handler) {
        socket.message({ type: 'response', id: frame.id, error: { code: -32601, message: `not implemented: ${frame.method}` } })
        return
      }
      try {
        const out = await handler(frame.params ?? {})
        const response = { type: 'response', id: frame.id }
        if (out && out.error) response.error = out.error
        else response.result = out && Object.hasOwn(out, 'result') ? out.result : out
        socket.message(response)
      } catch (error) {
        socket.message({ type: 'response', id: frame.id, error: { code: -32603, message: String(error?.message ?? error) } })
      }
    }
  }
  return ws
}
