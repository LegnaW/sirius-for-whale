# 2026-10-31（补）：工具可见性到底为什么丢，和"躺在床上的哑巴"

## 1. `restrict({allow})` 只认全局工具 —— 名单里混进 scope-local 名字就整份失败

**现象**（用户报）：Sirius agent 只能看到 19 个 `sirius_*`，`read`/`write`/`subagent`/`todo`
全都不见了。

**宿主契约**（`cordis_inspect_query` → Service `tools.restrict`）：

> Restrict **global** tools for the calling agent scope. Empty filters, **unknown names,
> scope-local names**, and reserved transport names fail. Restrictions intersect;
> **scoped registrations remain visible**.

也就是说：

| | 归属 | restrict 能不能管 |
|---|---|---|
| `sirius_*`（本插件全局注册） | 全局 | ✅ 能放行、能挡 |
| `read/write/edit/glob/grep`、`todo_write`、`job_*`、`subagent/send_message/…` | **preset 里挂出来的 scope 工具** | ❌ 名单里带上它们 → 整次调用抛错 |

旧代码把 32 个名字一把塞给 `restrict`，于是抛错 → 兜底逻辑从报错文本里读回"已知全局工具"
→ 只剩 19 个 `sirius_*`，她的 fs 和派活能力全被自己的白名单误杀。

**修法（两件事，各管一半）**

1. `preset-sirius` 的 `plugins` 里显式挂上她需要的东西：
   `dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-jobs` / `dsh-tool-todo` /
   `dsh-tool-subagent` / `dsh-tool-subagent-control`。
   scope 工具不归 restrict 管，所以挂上就一定可见。
2. 插件侧 `existingGlobals()`：先用 `ctx.tools.get(name)` 逐个探测，
   **只把真实存在的全局名**交给 `restrict`，并把这批结果写进
   `sirius_status.diagnostics.tools = { requested, allowed, dropped }`。
   下次再有人问"她为什么看不到 X"，一条 `sirius_status` 就有答案。

⚠️ **preset 组成是会话级快照**：`editing-cordis-compositions` 明确写了
"Existing sessions and their children keep the plugin revision they started with"。
所以改完 preset 必须**开新会话**（重启 DSH 只保证新会话拿到新组成）。

## 2. 躺在床上发不出消息

**现象**（用户报）：在床上（睡觉）时有聊天框但发不出去。

**取证**：`sirius_status` → `screen: "InBedChatScreen"`、`inGame: true`、`ready: false`。
`sirius_say` 当时用的是 `requireReady()`，于是被自己拦住：
`ready` 的定义是"在游戏里 **且没有界面**"，而睡觉必然有 `InBedChatScreen`。

**真相**：`chat.send` 走 `ClientPacketListener.sendChat`，本来就是界面免疫的
（这也是它存在的理由：死亡屏也能喊话）。实测在她睡觉时直接 `chat.send`
→ 截图里聊天栏出现 `<Sirius> 今晚先睡了，有事明天说`，`sent: true`。

**修法**：`sirius_say` 改用 `requireInGame()`；`sirius_command` 按前缀分——
`#`（chat.send 通道）只要"在游戏里"，`/`（要开聊天栏）仍然要求 ready。
