# sirius_init 支持 game_dir

## 目标与接口

`sirius_init({game_dir?})` 允许主会话在接管身体时指定 Minecraft 实例目录。DSH 只从 `<game_dir>/config/sirius_bridge.toml` 读取 token 和端口，不增加 token 参数，也不要求 agent 接触 token。

未传 game_dir 时沿用原候选顺序和当前连接配置；传入后 reset 旧连接，再用新候选和端口完成握手及事件重订。该覆盖保存在当前 BridgeLink 中，后续无参数 init 不无意切回其它实例。

## 安全与失败边界

- 目录为空、缺少配置文件、文件不可读或 token 为空时，在 ownership.activate、retireAll 和 reset 之前拒绝，旧所有者和挂载不受影响。
- configure 只允许在无 socket/握手任务时调用；init 的 reset 完成后才执行，保留 wanted 事件集合，清理连接级订阅状态。
- 不返回或记录 token，只返回 game_dir 和协议等诊断信息。

## 验收

- 指定目录读取 token/端口，缺文件与空 token 提前拒绝。
- configure 后下一次连接使用新 URL 和 token 来源。
- sirius_init 工具原样转发 game_dir，子代理仍不能 init。
- 完整 `npm test` 与 `git diff --check`；真实客户端 init 另行记录。

## 收尾记录

- 新增严格按指定目录解析配置的辅助函数；缺文件和空 token 在接管前拒绝。
- BridgeLink.configure 支持 reset 后替换 URL/tokenCandidates；连接级事件状态清理，wanted 保留。
- sirius_init 接受并转发 game_dir，返回实际目录，不接受 token。
- 最终 `npm test` **284 passed / 0 failed**，新增配置和 configure 回归，工具参数转发回归同步更新；`git diff --check` 通过。DSH 页面端 init 真机待验，插件代码需重启 DSH 后生效。

## game_dir 候选丢失缺陷修复

- 真机反馈定位：初版 init 组装 `{gameDir,candidates,url}`，configure 却读取 `tokenCandidates`，导致真实目录也被清空候选。
- 新增 `bridgeConnectionForGameDir` 统一生成 `{gameDir,url,tokenCandidates}`，init 不再手工拼装字段。
- 新增“目录配置 → 连接参数 → configure → 握手”全链路回归，验证 tokenCandidates 不丢失；假路径提前拒绝的既有行为不变。
