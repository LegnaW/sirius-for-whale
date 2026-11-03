# 2026-11-03 会话：攻击、隧道、受击抢占、官方 Skill 与恢复

## Plan + Spec（用户已确认）

### 动作插件

- `core.attack`：UUID/名称/半径目标，hits/dead、count、interval、wait_cooldown、max_seconds、min_health；锁定首次 UUID，低血/消失/超距/超时/取消如实结束，不追怪。
- `core.tunnel`：封装 Baritone Builder API，height 2..16、width 1..16、depth 1..256、timeout_ms；监视 operation id 和区域终局，取消/抢占停止，结束恢复 allow_break/place=false。
- 旧硬编码 attack/tunnel 保留 A/B。

### 受击打断

- `core.damage_watch` 新增 manifest 默认 arg `interruptTasks=true`。
- 首次未被伤害冷却抑制的 damage 会调用 `ctx.plugins.interrupt({mode:'task'})`，停止优先级低于 90 的活跃 task，状态为 preempted；不会停止其它 service，不会默认反击。
- 打断结果写入通知；原始事件和 30 秒唤醒冷却语义不变。

### 首个官方 Skill

- 通过 DSH 官方 `ctx.skills.register` 注册 `sirius-builtins`。
- 正文是全部 core.* 的具体使用方法：动作、参数、返回词表、启停与 run/status 示例、walk/dig_to 安全区别、craft 先研究配方、attack/tunnel 风险和受击打断。
- 随包 `skills/sirius-builtins/SKILL.md`，加入 package files；正文不包含本机路径、token 或账号信息。

### checkpoint 跨进程恢复

- 新增可选 `plugins.runStateFile` JSON 原子持久化，记录注册插件的 run id、args、owner、mode、checkpoint 和终局；空配置保持现行为。
- 仅 task/service 参与恢复，once 不自动重放。宿主启动时旧活跃 run 标记 interrupted，enabled service 恢复订阅；活跃 task 以 `resume_checkpoint` 和 `resume_from` 启动新 run。插件更新/删除使旧恢复项失效。
- 恢复是协作式的：通用脚本通过 `ctx.args.resume_checkpoint` 自行核对并续做，不能凭空推断未 checkpoint 的进度，不保证 exactly-once，不回滚世界副作用。
- `core.craft` 每批保存 completed/result_item/inventory_after；恢复时先核对目标产物数量，数量不足返回 resume_conflict，不盲目重做。数量吻合后从下一批继续，已完全完成返回 already_completed。
- persistent service 失败后的进程内重启也传递最近 checkpoint。

### 验收

- attack 命中/锁定/低血/超时/取消，tunnel done/blocked/取消/设置恢复。
- damage 打断低优先级 task、保留 service、冷却后不重复打断。
- Skill 注册内容覆盖全部内置 id，DSH `skill(name='sirius-builtins')` 可加载。
- JSON 恢复、once 不重放、service checkpoint、craft 续做与 resume_conflict。
- 完整 `npm test`、两仓 `git diff --check`、README/PROGRESS/local 更新。
- DSH 网页若多次重启/重试仍不接受指令，停止真机测试并明确报告；不无限重试。游戏当前关闭，只有确认可安全测试时才启动。

## 实施与自动验证

- 新增 combat.mjs：attack 锁定 UUID、低血/终局/超时/取消；tunnel Builder 终局、进度 checkpoint 和安全设置恢复。
- `ctx.plugins.interrupt` 仅停止低于调用者优先级的指定 mode；damage_watch 首次伤害打断 task，保留 service，冷却内不重复。
- 新增官方 `sirius-builtins` Skill 与随包 SKILL.md，覆盖全部 10 个内置插件。
- 新增 PluginRunStore：原子 JSON、task/service 恢复、once 不重放、旧 run interrupted、更新/删除失效、persistent 重启传递 checkpoint。
- craft 改为 task，每批记录 completed/result_item/inventory_after；恢复核对实际产物，支持 already_completed/resume_conflict。
- 修复运行记录内部 id 与公开 run_id 不同导致 checkpoint 未落盘的问题。
- 完整 `npm test`：**270 passed / 0 failed**；两仓 `git diff --check` 通过。
- DSH 首次启动发现缺少 skills inject，已补上 `inject=['tools','systemPrompt','agents','skills']` 并重启，随后插件正常激活且无启动警告；最终完整回归再次为 270/270。
- **网页 Skill 实测未成功**：多次出现草稿未提交或会话不执行，按用户要求停止重试，不宣称 skill 工具真机通过。游戏保持关闭，attack/tunnel/受击打断也未做真机验收。
- 用户代为测试时首先发现模型检测不到 `skill` 工具。根因是 Sirius preset 只注册了 skills 服务，没有注册 Consumer `@deepseek-ai/dsh-tool-skill`；已加入 cordis.patch.yml。preset 组成变化需重启 DSH 并新建 Sirius 会话，旧会话不能用于验证。
- **官方 Skill 联合验收通过**：新 Sirius 会话成功调用 `skill(name="sirius-builtins")` 并加载正文，attack/tunnel/craft 参数和 damage_watch 打断规则与实现一致；`sirius_plugin list` 返回 10 个内置插件、0 个用户插件，damage_watch enabled+running。此次仅做只读检查，没有执行游戏动作。

## 用户真机报告与缺陷修复

报告保存在本机测试报告目录的 `core-plugin-acceptance-2026-11-03.md`，不随仓库发布。

- attack 真机通过：NoAI 僵尸 20→0，result=dead，attempts=23、hits=22。
- tunnel 真机通过：首次因快捷栏无镐 no_progress，换入铁镐后 2×1×2 done，目标四格石头变空气，安全设置恢复。缺工具诊断和 progress 语义列入已知限制。
- 受伤抢占首次无效：sirius_init 终止 damage_watch 后 enabled=true 但 active=[]。已在 init 的连接和事件订阅恢复后调用 plugins.restore，enabled 常驻插件绑定新 owner 重启。
- 第二次抢占 run=preempted 且只唤醒一次，但 BuilderProcess 继续挖掘。已将 baritone.stop 和 allow_break/place=false 集中到 ScriptRuntime.stop(reason=preempted)，确保任何抢占都同步停止真实动作，而非仅修改 run 状态。
- 新增两项回归，完整 `npm test`：**271 passed / 0 failed**。
- **两项修复均真机复测通过**：sirius_init 后 damage_watch 自动恢复 active/running 并绑定当前会话；受击后 tunnel run=preempted，Baritone state=idle、goal=null、builder_active=false、人物不再移动，无需补 sirius_stop。damage_watch 持续 running，伤害只唤醒一次，最终 HP20/survival，测试场地按约定保留。
