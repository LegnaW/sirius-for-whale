# 2026-10-31：Baritone 命令改走 `chat.send`（不再开聊天栏）

## 起因

用户报两件事：① Baritone 走路是靠"输入指令"（开聊天栏打字）实现的，能不能别这样；
② 顺带发现"对着某些生物按 T 有别的效果"。诉求核心是：**别把聊天栏当控制通道**。

## 查到的机制（读 Baritone 源码 + 扫线上 jar）

- Baritone 的命令入口是 `@Mixin(ClientPacketListener.class)` 注入
  `sendChat(Ljava/lang/String;)V` 的 **HEAD**（`MixinClientPlayNetHandler.sendChatMessage`），
  命中 `#` 前缀就 `ci.cancel()` 交给命令系统 —— 消息永远到不了服务器。
- 桥的 `chat.send` 调的正是 `connection.sendChat(text)`（`ChatTools.java:81`）。
- 线上那个 `baritone-standalone-neoforge-1.11.2.jar` 虽然把 344/492 个类混淆成 `baritone/a.class`、
  `baritone/api/**` 只剩 4 个类（**反射调 API 没戏**），但 mixin 类名必须保留，
  `MixinClientPlayNetHandler.class` 里仍能搜到 `sendChat` / `sendChatMessage` → 钩子生效。

旧笔记 `M4.4-real.md §3.1` 说"`chat.send` 不执行 `/` 或 `#`"是**过度推广**：
那次测的是 `/give`（服务器命令，`/` 是聊天栏自己的特判，确实不行），`#` 从没测过。

## 真机取证

| 取证 | 方法 | 结果 |
|---|---|---|
| 拦截 | 截图看聊天 HUD | `[Baritone] > goto 57 90 -771` / `Going to: GoalBlock{x=57,y=90,z=-771}` |
| 真的动 | `getStats` 轮询坐标 | 15s 走 9.85 格（×2 次，另一次 8.65 格） |
| 不泄漏 | 截图 HUD 只有 Baritone 的行 | 没有 `<Sirius> #goto …` |
| 界面免疫 | 全程没按 T，`input.key` 调用为 0 | ✅ |
| 身体正常 | 对照：注入 W 0.9s | 位移 1.26 格 |

截图：`chatsend-baritone-going-to.jpg`、`chatsend-baritone-stop.jpg`。

## `chatControl` 保险（A/B 都做了）

`Settings.chatControl` 默认 `true`：Baritone 会吞掉**任何能被解析成指令的普通聊天**
（她单独说一句 "stop" 就消失）。所以策略是连上后发一次 `#setting chatControl false`。

| 状态 | 发一句普通 `stop` | 截图 |
|---|---|---|
| `chatControl=true` | 被吃：`[Baritone] > stop` / `ok canceled`，HUD 无 `<Sirius> stop` | `chatcontrol-on-eaten.jpg` |
| `chatControl=false` | 原样进服务器：HUD 出现 `<Sirius> stop`；`#` 前缀照旧工作 | `chatcontrol-off-passes.jpg` |

关掉后 `#goto` 仍然驱动移动（8.65 格），说明 `prefixControl` 不受影响。

## 改了什么

- `src/tools.mjs`：`sendCommand()` 按前缀分通道 —— `#` → `chat.send`（不开界面、不睡等待）；
  `/` → 老的 T→文本→ENTER。`applyBaritonePolicy()` 增加一次性的 `#setting chatControl false`。
- `src/plugin.mjs`：`baritone` 缓存加 `chatControl`，断线时一并清零。
- `src/walk.mjs` / `src/prompt.mjs` / `README.md`：把"聊天栏被界面挡住"的旧说法改掉。
- `test/tools.test.mjs`：`textsOf()` 同时认 `input.text` 与 `chat.send`；新增 3 个用例
  （`#` 不按键、`/` 仍按键、`chatControl` 只发一次）。154/154 绿。

单次命令从 ~1.66s（ESC→T→text→ENTER 四段 sleep）降到 ~0，且不再抢键盘。

## 过程中的两个坑（以后别再踩）

1. **4 格以内的 `#goto` 可能不走**：目标落在树冠里（`GoalBlock` 本身是实心方块），
   `allowBreak=false` 下寻路失败但**不打印报错**，看起来像"命令没生效"。测通道要用 >10 格的目标。
2. **旁路 WebSocket 连接的 `events` 收不到自己的 chat**：我用"事件里有没有出现 `#` 回显"判断泄漏，
   结果连普通聊天 `echo-test-51879` 都是 0 条事件（HUD 里明明有）。
   **泄漏判定必须用截图，不能用事件流。**
