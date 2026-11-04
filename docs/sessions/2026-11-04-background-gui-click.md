# 失焦 GUI 点击

sirius_click 与 core.input 使用协议 1.13 的 input.click at。旧桥沿用原坐标点击流程。

真机验收覆盖窗口失焦但未最小化、原版及模组按钮、界面切换。

验证：npm test 退出码 0；点击及工具定向测试 79 项通过，包含新版直发和旧桥坐标转换，git diff --check 通过。真机待验。
