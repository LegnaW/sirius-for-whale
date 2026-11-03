# core.drop 内置插件

## 方案

新增一次性内置 `core.drop {slot,count?}`，薄调用 bridge 1.12 的 `inventory.drop`。槽位沿用 `sirius_inventory` 的 0..40 编号；count 省略为整组。`inventory.drop` 纳入 ActionScheduler 的 inventory 资源，避免与合成和容器转移并发。

内置总数由 10 增至 11，官方 Skill、README 和进度记录同步。DSH 的 `sirius_*` 工具总数保持 30，不新增硬编码工具。

## 验收

- Node 回归：指定槽位/数量原样透传、省略 count、bridge verdict 原样返回、inventory 租约释放。
- `npm test` 与 `git diff --check`。最终复测 **272 passed / 0 failed**，`git diff --check` 通过。
- 真机待验：重启 DSH 后由 Agent 加载 Skill 并运行 core.drop，核对实际物品实体和剩余数量；bridge 新 jar 重启客户端后生效。
