# Sirius for Whale · 天狼星与鲸

Sirius 的 DeepSeek Harness 宿主插件，通过 sirius-bridge 连接真实 Minecraft 客户端，为 agent 提供感知、动作、事件和可持久化脚本能力。

项目仍处于早期开发阶段，敬请期待。

长方体采集 core.gather 需要 Bridge 协议 1.17 或更新版本。

sirius_walk、core.walk 和 core.dig_to 默认按方块格验收到达。显式传 tolerance 可使用近似到达。

后台 GUI 坐标点击需要 Bridge 协议 1.13 或更新版本。

详细实现、安装与配置说明见 [docs/PLUGIN.md](docs/PLUGIN.md)。

内置插件用法见 [sirius-builtins](skills/sirius-builtins/SKILL.md)；自定义插件开发见 [sirius-plugin-development](skills/sirius-plugin-development/SKILL.md)。

开发规范见 [AGENTS.md](AGENTS.md)；当前进度与验证状态见 [docs/PROGRESS.md](docs/PROGRESS.md)。

感谢 Kimi K3.1 Pro 提供的技术帮助！
core.gather 使用 from/to 两个角点（包含端点，顺序任意），blocks 必填，可用非空方块 ID 数组筛选。只有显式 blocks:"all" 才采集区域内全部可破坏的非空气方块；缺失、空数组和空字符串都会拒绝执行。allow_other_blocks 默认 false，开启后可破坏通往目标的沿途障碍。逐轮重扫，直到无进展、达到可选 max_blocks 或超时；默认采集全部目标。单次最多 4096 格，timeout_ms 默认 180000，最多 280000。collected 是完整背包正增量，inventory_delta 包含正负变化。remaining 和 scan 报告残余目标及未知范围，uncollected 依据玩家附近的可见实体。旧版 x/y/z/range 调用继续兼容。

```json
{"from":{"x":0,"y":64,"z":0},"to":{"x":8,"y":70,"z":8},"blocks":["minecraft:oak_log"],"allow_other_blocks":false}
```


注册脚本支持 look、lookAt、input.text 与 chat.send；公屏聊天需要身体主会话权限。转向与挖掘、战斗、寻路共用视角租约。插件启动的持续移动会在实例终止时清理；使用 task/service 保持移动任务运行。截图与事件分别使用 ctx.screenshot 和 ctx.events.subscribe。

core.gather 会从快捷栏自动选工具，优先保证正确掉落，再比较含附魔效率的速度；支持模组方块和工具。遵守 Baritone 耐久保护、剑采掘及精准采集偏好设置。主背包里的工具请先放到快捷栏。无合适工具返回 wrong_tool。
