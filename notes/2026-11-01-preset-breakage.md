# 2026-11-01：往 preset 里加插件 → 「Sirius」模式从选单里消失了

## 事故经过

2026-10-31 为了提高她的工具可见性，我往 `cordis.patch.yml` 的 `preset-sirius.plugins`
里加了四行：

```yaml
- id: tool-fs             name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search      name: '@deepseek-ai/dsh-tool-fs-search'
- id: tool-subagent       name: '@deepseek-ai/dsh-tool-subagent'
- id: tool-subagent-control name: '@deepseek-ai/dsh-tool-subagent-control'
```

重启后 **DSH 里「Sirius」这个 agent 模式选项整个消失**。

## 定位

`plugin_manager list_plugins` 里 `include:preset-sirius` 仍然是 `enabled: true / active`，
但选单里没有它 —— 说明**声明的激活失败**，preset 没进 roster
（官方说法："A declaration whose activation fails stays on the roster with its diagnostic
and cannot compose a session"；实际表现是选单里看不到）。

四个包在 dsh 安装目录里都存在（不是模块缺失），所以看它们的服务依赖：

| 包 | inject |
|---|---|
| `dsh-tool-jobs`（原本就有，能用） | `tools, jobs, systemPrompt` |
| `dsh-tool-todo`（原本就有，能用） | `tools, sessionProjections` |
| `dsh-tool-fs` | `tools, fs, **systemPrompt, workingDirectory**` |
| `dsh-tool-fs-search` | `tools, systemPrompt, subprocess, **workingDirectory**` |
| `dsh-tool-subagent` | `tools, **subagents**, systemPrompt, sessionProjections` |
| `dsh-tool-subagent-control` | `tools, **subagents**` |

**最可疑的是 `workingDirectory`**：它是**按会话**提供的（每个 agent 有自己的工作目录），
在 preset 的"一次性 eager activation"阶段往往还不存在 → 依赖它的插件永远停在 PENDING
→ preset 的 `register()` 等不到全部子插件就绪 → 声明没注册成功 → 选单里消失。

## 处理

1. `preset-sirius.plugins` **回退到验证过能起的三行**（`tool-jobs` / `tool-todo` / `compaction` 组）。
2. 想加的东西**一次只加一个**，每次重启后确认「Sirius」还在选单里，再加下一个。
3. 插件侧加了保险：`existingGlobals()` 探测不到任何全局工具时**直接跳过 restrict**
   （宁可不限制，也不要因为抛错把她变成废人）。

## 教训

- **preset 的 `plugins` 列表不是"想挂什么就挂什么"**：子插件带 `inject` 的，
  必须在 preset 激活时就能拿到那个服务；按会话提供的服务（`workingDirectory`）不行。
- 改 preset = 改 bundle patch，**必须重启 + 开新会话**才能验证，成本很高 ——
  所以一次只改一处。
- 用户那边的表现是"模式选项消失"，看起来像插件丢了，实际是 preset 声明没激活。
