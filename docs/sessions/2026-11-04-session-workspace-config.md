# 会话级脚本目录与声明式插件配置

## 目标与边界

每个 Sirius 主会话在自己的工作区保存用户脚本、插件配置和运行 checkpoint。`sirius_init` 初始化目录并挂载该会话配置；只有当前身体所有者的配置可以操作游戏。子代理继承主会话配置，非所有者可编辑和验证自己的文件，但不能改变当前挂载。

不修改 bridge、Worker 动作权限或 core 插件代码。保留无工作区的旧 PluginManager 用法和全局存储降级路径。

## 目录与配置

```text
<workspace>/
  scripts/<user-id-suffix>.mjs
  config/plugins.json
  state/runs.json
  state/last-known-good.json
```

`scripts` 与 `config/plugins.json` 是 agent 可编辑的声明式输入；`state` 只由宿主维护。脚本路径由 user.* ID 推导，不接受任意路径。core.* 只允许覆盖 enabled/args，user.* 允许 manifest/args/enabled，代码从 scripts 读取。

只有 `mode=service` 且 `persistent=true` 的插件可在配置中 enabled=true。once/task 和非持久 service 仍可显式 run，但不把一次运行写成永久期望状态。配置未列出的 core 使用包默认；配置中的 user 集合是该会话用户插件的声明式来源。

## 初始化与提交

- init 先初始化并预检新会话配置，再切换身体、停止旧 run、重连和挂载；预检失败不改变当前所有者。
- submit 完整读取和校验候选配置，任何错误都不停止现有服务。按定义、args 和 enabled 差异应用：未变服务保持运行，变化或删除才停止，新增/重新启用才启动。
- 配置显式 submit 才生效，不监听文件变化。非所有者 submit 拒绝。
- 成功后保存包含配置和脚本的 last-known-good。init 遇到损坏输入时可明确降级到最后有效版本；submit 不使用该回退，必须修正当前文件。
- enable/disable 的持久化只针对 persistent service；create/update/delete 同步当前会话声明文件。run 的临时 args 不改配置。
- runs.json 按会话隔离，恢复只发生在对应所有者的 init/宿主恢复路径，once 不重放。

## 工具

扩展 `sirius_plugin`，不新增硬编码工具：`config` 查看当前会话文件与校验状态，`validate` 完整预检，`submit` 应用当前所有者的配置。init 返回工作区配置摘要和降级信息。

## 验收

- 初始化不覆盖已有文件；脚本路径约束、JSON/manifest/args/core 不可变校验。
- 非法 submit 零挂载变化；未变服务不重启；args/代码改变只重启目标；禁用和删除停止实例。
- 同名 user 插件在两个工作区互不影响；非所有者不能提交；子代理不建立第二套配置。
- 会话切换不恢复旧所有者服务或 checkpoint；对应会话恢复 persistent service 和 task checkpoint，once 不重放。
- 原 273 项回归保持，新增真实 Worker/临时工作区回归；`npm test` 与 `git diff --check`。
- DSH/客户端真机需验证 init 建目录、agent 编辑后 submit、服务启停和 DSH 重启恢复；未执行则明确记录待验。

## 收尾记录

- 新增 `WorkspaceConfig`：初始化且不覆盖、core/user 校验、脚本真实路径约束、原子声明文件同步和 last-known-good 回退。
- 新增 `SessionPluginManager`：每会话注册表与 runs.json、init 预检后挂载、submit 差异启停、非所有者拒绝和旧全局降级。core 定义仍不可改，Worker/ActionScheduler 未重写。
- `sirius_plugin` 增加 config/validate/submit；create/update/delete 与 persistent enable/disable 同步声明文件。子代理通过 ownerRoot 使用主会话目录，常驻服务仍绑定主会话所有者。
- 正式新增 6 项回归（4 项会话/配置场景、1 项子代理、1 项工具所有权）；最终 `npm test` **279 passed / 0 failed**，原 273 项全部通过，`git diff --check` 通过。
- 完整 DSH/客户端联合真机尚未执行，当前结论为真实 Worker + 临时工作区垂直验收，不冒充页面端验收。
