# 2026-11-01：图片来源硬上限 → 会话被 400 打死

## 现象

`400 invalid params, the num of image is larger than the limit: 20 (2013)`。
一张 `sirius_screenshot` = 历史里一张图，攒到 20 张之后**每次请求都失败**，重试也一样。

## DSH 本来有这套机制（但没被触发）

`dsh-compaction-image-offload` 已经实现了完整链路：

- 持久投影 `image/offload`：按 `{seq, imageIndexes}` 把某些 `ImageBlock` 标成 `offloaded: true`，
  之后**所有路由对这些图只发占位文本**（不是删历史，附件还在）；
- `offloadOldestImages(session, sourceEventSeqs, count)`：挑最老的若干张，追加一条
  `image/offload` 事件；
- 触发条件是 `agent/request-error` 里 `failure.code === IMAGE_OFFLOAD_REQUIRED`
  **且** `failure.offloadImages` 有值 —— 也就是适配器得先把"图片超限"翻译成这个错误码。

我们拿到的是一句裸的提供商 400（`2013`），适配器没翻译 → 恢复逻辑不触发 → 会话直接卡死。
**机制齐了，缺一根导线。**

## 这一版做的：源头节流（方案 C）

`config.screenshot.maxImages`（默认 **6**），`sirius_screenshot` 按 agent 分别计数：

| 参数 | 行为 |
|---|---|
| 不给 `attach` | 预算内附图；用完只回尺寸/质量（`attached:false`） |
| `attach: true` | 强制附图（可超预算，人工兜底） |
| `attach: false` | 永不附图（只想确认"屏幕亮着/界面开了"时用） |

返回值多了 `attached` 和 `image_budget: {used, max}`，摘要会明说
"本会话附图额度已用完 6/6（确需看图用 attach=true，或 tier=\"crop\" 截关键区域）"。
提示词也加了一句：别拿截图当默认手段、优先 `crop`。

计数器随 `agent/disposed` 清理。注意它是**保守**的：历史被压缩后计数不清零，
所以压缩之后仍可能提前进入"不附图"状态 —— 想强制看图就 `attach: true`。

## 没做但记下来的（方案 A / B）

- **A（正解）**：适配器把"图片超限"映射成 `IMAGE_OFFLOAD_REQUIRED` + 超额数量。
  要改 DSH 本体，升级会被覆盖 → 适合提上游 issue。
- **B（能救老会话）**：插件照着 `offloadOldestImages` 自己实现：监听 `agent/request-error`，
  认图片超限 → `agent.session.append('image/offload', { targets })` → 返回 `{kind:'retry'}`。
  依赖 `agent.session.append` / `session.surface.nodes` 这些内部 API，需要先验证再上。
