# DeepSeek Harness Activity Inbox

一个独立的 DeepSeek Harness 插件：把 Agent 的真实运行结果整理成低噪音、可追溯的活动收件箱。插件只在侧边栏增加一个 **Activity** 入口，不修改 Harness 核心代码。

## MVP 能力

- **Needs action**：等待审批、回答、计划评审，或明确报告为 `blocked` 的任务。
- **Failed**：真实的 `turn/end` 失败，包括错误、达到 token 上限和异常中断。
- **Completed**：真实完成的回合，方便确定性回顾。
- **Following**：持续关注指定任务，包括仍在运行或暂时空闲的任务。
- **Reviewed / Snooze / Archive**：单操作者的持久状态；新回合结束后，旧的已读、稍后提醒或归档状态不会压住新活动。
- **子 Agent 路由**：能直接打开子 Agent 时打开子 Agent，否则打开其父任务。
- **证据优先**：每条终态活动来自 Harness 的持久 Session 日志，并显示来源事件序号；插件不会调用模型生成摘要。
- **环境式 Pet**：侧边栏伙伴复用同一套确定性活动事实，展示运行、等待、待审阅、阻塞、失败、空闲和离线状态。
- **桌面端就绪的 Presence 协议**：Host 统一维护实时状态，并导出带实例与 revision 语义的浏览器安全 `./presence` 契约。
- **本地认证 Presence**：macOS 通过仅当前用户可访问的 Unix Socket 推送 revision，Bearer Token 只保存在 Keychain，不创建明文凭据文件。
- **原生桌面 Pet**：`desktop/` 中的 Tauri 客户端提供透明置顶窗口、边缘吸附、鼠标穿透和菜单栏恢复入口。
- **Host 托管生命周期**：Inbox 可启动或停止已发现的桌面构建，浏览器侧无法传入可执行路径或直接控制任意进程。
- **可信平台工件**：macOS 构建使用整包文件哈希清单、原子切换、单版本回滚、版本握手与单实例恢复。

红色角标只统计尚未处理的实时等待，以及未读的 blocked / failed 结果。普通完成项保留在收件箱中，但不会制造角标噪音。

## 从打包文件安装

要求：DeepSeek Harness `0.1.1-rc.2`，或从 `0.1.2-alpha.1` 到 `<0.2.0` 的版本；Node.js 22.19+（或 24+）；Web Profile。

请从 [v0.1.2 GitHub Release](https://github.com/chenjie1129/deepseek-harness-activity-inbox/releases/tag/v0.1.2) 下载 `chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz`。若希望从克隆的源码自行构建，请先在本仓库运行 `npm install`，再运行 `npm pack`。

```bash
cd /path/to/deepseek-harness
npm run dsh -- plugin --profile web add /absolute/path/to/chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz
npm run dsh -- --profile web
```

插件在文件系统中只写入操作者偏好：

```text
$DSH_HOME/activity-inbox/state-v1.json
```

macOS 默认启用本地 Presence Bridge：

```text
$DSH_HOME/activity-inbox/presence-v1.sock
```

目录权限为 `0700`，Socket 权限为 `0600`。256-bit 传输 Token 保存在
macOS Keychain 的 `com.deepseek-harness.activity-inbox.presence` service
中，account 由 Socket 绝对路径稳定派生，不会生成明文 Token 文件。

可在 Cordis 配置中覆盖路径或关闭桌面 Bridge：

```yaml
- id: activity-inbox
  name: '@chenjie1129/dsh-activity-inbox-plugin'
  config:
    presenceSocketEnabled: true
    presenceSocketPath: /absolute/path/to/presence-v1.sock
    presenceAuthTimeoutMs: 5000
    presenceMaxClients: 8
```

桌面客户端使用 NDJSON，必须先发送 `presence/auth`，再发送
`presence/subscribe`。Host 返回 `presence/snapshot` 或
`presence/unchanged`，并主动推送后续 revision。Node 本地集成可使用
`./presence/host` 导出的 Keychain 描述符和 Socket 工具。

启动兼容的 Harness Host 后，可构建 macOS 桌面客户端：

```bash
cd desktop
npm install
npm run check
npm run tauri -- build
```

仓库开发模式下，Host 会自动发现本地 release 构建。打包部署可配置
`desktopPetExecutablePath`。`desktopPetAutoStart` 默认关闭，
`desktopPetStopOnHostExit` 默认开启。
发布流程可通过 `DSH_ACTIVITY_PET_ARTIFACT` 或
`desktopPetArtifactPath` 指定平台包；显式工件校验失败时会直接拒绝，
不会回退到未校验二进制。

完成 Tauri Release 构建后，可生成当前 macOS 架构的平台包：

```bash
npm run desktop:artifact
npm pack --dry-run desktop/artifacts/darwin-arm64
```

在 Harness `0.1.2-alpha.1` 中，插件使用官方支持的 Typert Remote API；在 `0.1.1-rc.2` 中，会自动回退到旧版 Connection RPC。旧版 RPC 的默认权限为 `loopback`；只有在明确配置旧版 Harness Host 的可信远程来源后，才应改用 `trusted-host`。

## v0.1 不包含

- 不包含 Slack / Discord 集成、推送通知、邮件摘要或移动端。
- 不包含多人已读状态、分派、团队权限或共享收件箱。
- 不生成 AI 摘要，只展示可确定复现的运行事实。
- 暂不支持跳转到单个事件；当前 Harness UI 提供的是任务级导航。
- 若持久化后端无法读取某个 Session，不能声称该 Session 已完成历史回填；面板会显示失败数量。

更多信息见 [架构说明](docs/ARCHITECTURE.md)、[Pets 架构说明](docs/PETS_ARCHITECTURE.md)、[测试说明](docs/TESTING.md) 和 [安全说明](SECURITY.md)。
