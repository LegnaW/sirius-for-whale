# 内置插件参考副本与开发 Skill

## 目标

init 时把当前版本 core.* 的代码和 manifest 复制到会话工作区 `scripts/example/`，供 agent 阅读内置实现和编排方式。加载器仍只把 `scripts/<user-id>.mjs` 注册为用户插件，example 副本不可挂载，修改它不影响 core 注册表或运行实例；下次 init 覆盖为当前版本。

新增独立 `sirius-plugin-development` Skill，与 `sirius-builtins` 分工：前者教自定义插件开发、ctx API、事件、生命周期、嵌套和配置，后者继续查内置插件参数。

## 验收

- init 生成全部 core 的 example 代码及 manifest 索引；修改 example 后 submit 不改变 core 定义，下一次 init 恢复参考副本。
- 两个 Skill 均由宿主注册并可释放，无 skills 服务时保持降级。
- 开发 Skill 覆盖脚本签名、manifest、ctx.api、事件过滤、plugins.start/wait/stop、checkpoint、资源调度、开箱存物关窗示例和 validate/submit 流程。
- 完整 `npm test` 与 `git diff --check`；DSH 真机另行记录。

## 收尾记录

- `WorkspaceConfig.writeBuiltinExamples` 在 prepare/init 生成 13 个 `core.*.mjs` 和 `index.json`，包含代码、manifest 与参考专用标记；init 返回 `examples_dir=scripts/example`。
- example 不在用户脚本加载路径中。回归实际修改 `core.open_block.mjs` 后 submit，注册表代码保持不变且 changed=false；再次 prepare 后副本恢复。
- 新增 `skills/sirius-plugin-development/SKILL.md` 和独立注册函数，涵盖受限 Worker、全部 ctx 能力、事件目录/过滤、动作资源、嵌套、恢复、配置事务与开箱存物关窗示例。
- 最终 `npm test` **281 passed / 0 failed**，新增 example 与开发 Skill 两项回归；原 279 项保持通过。完整 DSH/客户端联合真机待验。
