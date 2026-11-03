# 2026-11-02 会话：跟随玩家与丢失提醒

## Plan + Spec（用户已确认）

新增 `sirius_follow`，对应桥端协议 1.9 `baritone.follow`。UUID 或精确玩家名二选一，`follow_radius` 默认 10 且 agent 可调，破坏和放置默认关闭。工具立即返回，不阻塞主会话。

后台 `FollowTracker` 每 2 秒读取 Baritone follow 状态与自身位置：

- `follow.active=false` 或目标列表为空，判定目标丢失，停止并通知一次。
- 跟随中自身移动至少 0.75 格或进入目标半径，记为有进展。
- 超过 4.5 秒无进展且仍在半径外，判定卡住，停止并通知一次。
- 新 walk/follow 取代、显式 stop、init 接管、会话销毁只取消跟踪，不发送丢失提醒。

状态加入 `sirius_status.diagnostics.follow`，通知统一走 `deliverWake`。`sirius_stop` 同时取消后台 walk 与 follow。

验收：跟随启动转发、默认和自定义半径、旧桥拒绝、丢失提醒、卡住提醒、移动不误报、取消不提醒；完整 `npm test`。真实 DSH/游戏验证待部署后进行。

## 收尾日志

### 文件改动

- `src/follow.mjs`：新增 FollowTracker，处理目标丢失、卡住、持续移动、进入半径、瞬断和取消。
- `src/tools.mjs`：新增 `sirius_follow`、协议 1.9 检查、默认/自定义半径、统一 stop 和状态摘要；walk 与 follow 互相取代。
- `src/plugin.mjs`：每 2 秒推进 follow，加入诊断、子代理工具面和近聊尾巴。
- `test/follow.test.mjs`：新增六类后台状态回归。
- `test/tools.test.mjs`、`test/policy.test.mjs`：新增工具转发、默认 10 格、自定义设置、旧桥和停止回归，工具数同步为 28。
- `README.md`、`docs/PROGRESS.md`：同步工具面、行为和真机验收项。

### 自动验证

- 聚焦测试：`node --test test/follow.test.mjs test/tools.test.mjs test/policy.test.mjs`，**79 passed / 0 failed**。
- 完整 `npm test`：**225 passed / 0 failed**。
- 桥端 `./gradlew.bat build`：**689 passed / 0 failed**。

### 部署与未完成

- 协议 1.9 新 jar 尚未部署；插件和桥都需要在部署后分别重启 DSH 与 Minecraft。
- 真实玩家跟随、默认 10 格、目标离开、不可达路线和提醒次数仍待真机验收。
