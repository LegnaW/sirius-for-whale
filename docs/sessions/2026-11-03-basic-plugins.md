# 2026-11-03 会话：基础内置插件 input / screenshot / walk

## Plan + Spec（用户已确认）

新增三个 `core.*` 内置插件，旧硬编码工具保留用于 A/B，不删除、不改变其默认行为。

### `core.input`

- 仅作没有精确对象接口时的键鼠兜底，manifest 明确 fallback 与低优先级。
- `{key,duration_ms?,modifiers?}` 支持数字键值、A-Z/0-9/F1-F12 与已有特殊键名；或 `{click:{button,at?,count?,hold_ms?}}`。
- click 可用当前光标，也可指定 GUI 坐标；通过 input.mouseMove 实测缩放，换算窗口像素并校验落点。count 与 hold_ms 互斥，bridge 的权限和焦点规则原样保留。
- input.* 也走 ActionScheduler interaction 资源，不允许绕过所有权或抢占。

### `core.screenshot`

- 参数与旧截图一致：tier full/crop、bbox、quality。
- Worker 只发 `ctx.screenshot(params)` 意图，宿主调用真实 bridge、保存到当前所有者工作区 images/，只返回路径和图片元数据，不返回 base64，不开放任意文件 IO。

### `core.walk`

- 参数：x/z/y?、tolerance 默认 1.5（0.5..8）、timeout_ms 默认 60000（5000..180000）、allow_break/allow_place 默认 false、open_doors 默认 true。
- 直接使用 baritone.settings/goto/stop/status，不走聊天命令解析；首次写动作取得 movement 租约，run 结束释放。
- 每 400ms 用真实坐标判断：水平 tolerance 且给 y 时高度差≤2；停止后等待 450ms 再复核位置。
- 4.5 秒无进展：读取 no_path/no_progress；已移动则搜索 8 格内门/栅栏门/活板门/按钮/拉杆，use 开门并重试一次；否则 blocked。
- 超时/抢占/取消不能宣称到达；系统停止和 scheduler 抢占额外发 baritone.stop，防止 Worker 终止后身体继续移动。完成通知通过 ctx.notify。

## 验收

- input 键名/数字转换、点击缩放和 count/hold 互斥。
- 截图只写宿主工作区，文件唯一、JPEG 可解码、响应无 base64。
- walk 到位、Y 公差、no_path/no_progress、开门重试、取消与抢占、租约释放、安全设置恢复。
- 原 247 回归保持，完整 npm test 与两仓 diff check。
- 真机：E 开关背包、截图实际 JPEG、短距离安全 walk 到位；旧工具仍保留，DSH 全宿主未重启则注明。

## 收尾日志

### 实现与自动验证

- 新增 `core.input`：键名/数字转换、当前/GUI 点击、缩放校验；input.* 纳入 interaction 调度，不作为绕过优先级的后门。
- 新增 `core.screenshot` 与 `plugin/screenshot.mjs`：宿主专用 `ctx.screenshot` 保存到当前所有者工作区，只返回路径与元数据，Worker 无任意文件 IO。
- 新增 `core.walk`：Baritone settings/goto/stop/status、坐标到位、Y≤2、450ms 停稳复核、4.5s 卡住、门重试、通知与安全设置恢复。
- ActionScheduler 抢占除取消 run 外，额外调用 baritone.stop 并恢复 allow_break/allow_place=false，避免 Worker 停止后身体继续移动。
- 新增 `test/basic-plugins.test.mjs`：键值、点击、截图文件、walk 到位/no_path/开门/抢占。开门场景预算从 5 秒延长到 7 秒，避免开门后尚未回读坐标便超时。
- 最终 `npm test`：**253 passed / 0 failed**；原 247 条回归保留。两仓 `git diff --check` 通过。

### 真机证据

- `core.input {key:"E"}` 返回 key_sent/code=69；等待 150ms 后实测 `CreativeModeInventoryScreen`、54 槽，第二次 E 后 screen_open=false。首次无等待读取处于按键释放窗口，已调整测试时序，生产实现未改。
- `core.screenshot` 返回工作区相对路径和 JPEG 元数据，实际文件 854×480、JPEG，已用读图确认是真实游戏画面；未向模型返回 base64，测试临时文件已清理。
- `core.walk` 两次短距离移动均 arrived，含 from/to/settled、target/tolerance 与 allow_break=false/allow_place=false；最终停稳位置复核成功，opened=false，未破坏或放置方块。
- 旧 sirius_walk/sirius_key/sirius_click/sirius_screenshot 保留用于 A/B。完整 DSH 尚未重启，因此不宣称完整 DSH 会话验收。临时探针已删除，客户端正常关闭，无关 server 未操作。

### 完整 DSH 会话联合验收（后续补记）

- 用户启动 DSH Web 与生存模式客户端后，使用浏览器新建 Sirius 会话。DeepSeek 实测协议 1.11、30 个 sirius_* 工具及全部 5 个内置插件 id，身体所有权和 READY 正常。
- `core.input` 两次 E：InventoryScreen 打开且 46 槽可读，第二次后无界面。evidence.screen_open 是按键前旧值，结果以随后 getGuiState 为准。
- `core.screenshot`：run succeeded/saved，854×480 JPEG q80，返回工作区 relative_path，DeepSeek 用 glob 确认文件落盘。
- `core.walk`：DeepSeek 自主查询地形并选择室内安全点 (-317,69,-136)，实际 from=(-314.992,69,-135.654) → settled=(-316.377,69,-135.503)，result=arrived，allow_break/place=false，最终 sirius_status 与 settled 一致。
- 联合验收时 DSH 与客户端保持运行，浏览器标签组保留。初连 diagnostics.protocol 短暂 unknown，后续变 1.11，是异步能力探测时序；run.timeout_ms 显示 manifest 上限，args 内部 walk 预算是独立字段，后续可统一展示口径，不影响本次到达结果。
