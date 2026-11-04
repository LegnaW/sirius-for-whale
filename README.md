# Sirius for Whale · 天狼星与鲸

Sirius 的 DeepSeek Harness 宿主插件，通过 sirius-bridge 连接真实 Minecraft 客户端，为 agent 提供感知、动作、事件和可持久化脚本能力。

项目仍处于早期开发阶段，敬请期待。

区域采集 core.gather 需要 Bridge 协议 1.14 或更新版本。

sirius_walk、core.walk 和 core.dig_to 默认按方块格验收到达。显式传 tolerance 可使用近似到达。

后台 GUI 坐标点击需要 Bridge 协议 1.13 或更新版本。

详细实现、安装与配置说明见 [docs/PLUGIN.md](docs/PLUGIN.md)。

内置插件用法见 [sirius-builtins](skills/sirius-builtins/SKILL.md)；自定义插件开发见 [sirius-plugin-development](skills/sirius-plugin-development/SKILL.md)。

开发规范见 [AGENTS.md](AGENTS.md)；当前进度与验证状态见 [docs/PROGRESS.md](docs/PROGRESS.md)。

感谢 Kimi K3.1 Pro 提供的技术帮助！