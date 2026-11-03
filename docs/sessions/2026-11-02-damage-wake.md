# 2026-11-02 会话：即时伤害唤醒与独立插件规范

> 本文是实施后的规范补记。伤害方案先经对话分析并由用户确认“先按照这个思路做一下”，随后实施；独立插件规范由用户随后要求补建。本文不把补记伪称为事前 spec。

## Plan + Spec（已确认方案）

### 背景

旧唤醒链只有 `health_low`，通常要等 agent 已接近危险血量才通知；Observer 的掉血报告又受观察周期、至少 2 点变化和汇报冷却限制。模型收到提醒后再思考和行动，可能已经被继续攻击致死。

目标是实际生命值只要下降就尽快唤醒，附伤害来源与近期聊天；默认 30 秒冷却，让玩家也能通过一次轻击叫醒没有响应的 agent。

### 桥插件分工

- 桥端新增协议 1.8 CRITICAL `damage`，每 tick 报告观察到的实际生命值下降和 `DamageSource`，不做唤醒冷却。
- 插件默认订阅 `damage`，Watchdog 对第一次伤害生成强唤醒；之后 30 秒内只抑制唤醒，原始事件仍可通过 `sirius_events` 拉取。
- 近期聊天继续统一由 `deliverWake` 附加，不新增第二套聊天采集。
- 保留 `health_low`、`death`、`fire`、`drown`。Observer 不再报告掉血，避免与即时事件重复叫醒。

### 插件报文与冷却

桥端输入：

```json
{
  "health_before": 20,
  "health_after": 19.5,
  "amount": 0.5,
  "damage_type": "minecraft:player_attack",
  "attacker": {"name":"Steve","type":"minecraft:player","uuid":"..."},
  "direct_entity": {"name":"Steve","type":"minecraft:player","uuid":"..."}
}
```

Watchdog 输出包含血量 `20 → 19.5`、损失 `0.5` 和来源；攻击者与直接伤害实体分别展示，可区分手持近战与骷髅射箭。来源缺失时写“未知”，不根据附近实体猜测。

冷却使用独立的 `lastDamageAt` 与 `damageCooldownMs=30000`，不借用弱聊天的 `quietAfterWakeMs`。被冷却抑制的事件增加 `damageSuppressed` 诊断计数；`wakeOn.damage=false` 可关闭此类唤醒。

### 验收

- 满血扣 0.5 也强唤醒；30 秒内第二次伤害不重复，冷却边界后再次唤醒。
- 玩家、怪物、弹射物和未知来源文案正确；开关可关闭。
- 所有唤醒仍带近期聊天；其它危险事件和聊天 golden 语料不回归。
- 真机必须在生存模式验证。创造模式、无 PvP、无敌帧或伤害被完全吸收而没有实际扣血时，不应当作“轻击唤醒”有效样本。

## 收尾日志

### 文件改动

| 文件 | 改动 |
|---|---|
| `src/bridge.mjs` | 默认事件订阅增加 damage |
| `src/watchdog.mjs` | 新增 damage 报文、来源格式、独立 30 秒冷却、开关和诊断计数 |
| `src/observer.mjs` | 移除延迟掉血报告，避免重复唤醒 |
| `src/plugin.mjs` | 同步 Observer 行为说明；近期聊天继续走 deliverWake |
| `test/watchdog.test.mjs` | 新增满血扣血、来源、冷却边界、未知来源和关闭开关测试 |
| `test/observer.test.mjs` | 明确掉血交给即时 damage 事件 |
| `README.md` | 增加 damage 事件、冷却与近期聊天说明 |
| `AGENTS.md` | 新建独立插件开发规范 |
| `docs/PROGRESS.md` | 新建跨会话状态锚点 |
| `docs/sessions/2026-11-02-damage-wake.md` | 补录本方案与收尾证据 |

桥端配套位于独立 `sirius-bridge`：`EventPusher` 每 tick 检查实际扣血，`DamageContracts` 组装事件，协议升至 1.8。

### 自动验证

- 插件 `npm test`：**212 passed / 0 failed**。
- 桥端 `./gradlew.bat build`：成功，**680 passed / 0 failed**。
- 两仓库 `git diff --check`：通过。

### 部署与未完成

- 协议 1.8 桥 jar 已备份旧版并复制到 `1.21.1-Sirius/mods/`，源/目标哈希一致。
- 游戏和 DSH 尚未重启；damage 的真实来源、近期聊天和 30 秒冷却仍待真机验收。
- 本轮及当前工作树中的所有权、Baritone API、截图等改动尚未再次提交；用户未要求提交，不在本轮擅自处理。
