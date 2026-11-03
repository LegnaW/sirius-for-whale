# 2026-11-01：`invalid output: value is not lossless JSON` —— 假失败

## 现象

用户报："经常遇到返回命令执行失败，但是实际上执行成功了。"
报错文本：`invalid output: value is not lossless JSON`。

## 机制

宿主把工具 `execute()` 解析出的**返回值**当 JsonValue 校验。只要值里出现
`undefined` / `NaN` / `±Infinity` / `bigint` / 函数 / Symbol / 循环引用，
整次调用就被判"输出非法"——**但 `run()` 早就跑完了，世界里的动作已经生效**。
于是模型看到的是失败，会去重试，结果重复执行。

对 `sirius_command` 来说最典型的一处是**我自己引入的**：

```js
const { closed, channel } = await sendCommand(text)   // `/` 分支以前只返回 { closed }
data: { sent, closed, channel, recentChat }           // → channel: undefined
```

`#` 分支回 `{ closed, channel: 'chat.send' }`，`/` 分支回 `{ closed }`，
于是 `/` 命令的 `data.channel` 恒为 `undefined` → 宿主判非法 → 报"执行失败"，
但命令其实已经发出去了。

## 修法：出口统一压一遍无损 JSON

新增 `src/json.mjs` 的 `toLosslessJSON()`，在 `defineTool.execute()` 的出口统一调用
（`image` 是附件句柄，原样透传）：

| 输入 | 输出 |
|---|---|
| 对象里 `undefined` 的键 | **删掉**（不留成 null，少给模型噪音） |
| 数组里的 `undefined` | `null`（下标不塌陷） |
| `NaN` / `±Infinity` | `null`（JSON 没这三个值） |
| `-0` | `0`（它 stringify 成 `"0"`，往返校验会判不无损） |
| `bigint` | 字符串 |
| 函数 / Symbol | 丢掉 |
| 循环引用 | 第一次出现处展开，回指处丢掉 |
| 有 `toJSON` 的对象（Date 等） | 用 `toJSON()` 的结果 |

另外把 `sendCommand` 的 `/` 分支补上 `channel: 'chatbar'`——根因就在这儿，不能只靠兜底。

## 测试

`test/json.test.mjs` 8 例（undefined / NaN / 数组洞 / 嵌套 + bigint + 函数 / 循环引用 /
`toJSON` / `-0`），`test/tools.test.mjs` 加一例"工具返回值一定会被压成无损 JSON"。
174/174 绿。
