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

红色角标只统计尚未处理的实时等待，以及未读的 blocked / failed 结果。普通完成项保留在收件箱中，但不会制造角标噪音。

## 从打包文件安装

要求：DeepSeek Harness `0.1.1-rc.2` 至 `<0.2.0`、Node.js 22.19+（或 24+）、Web Profile。

请从 [v0.1.0 GitHub Release](https://github.com/chenjie1129/deepseek-harness-activity-inbox/releases/tag/v0.1.0) 下载 `chenjie1129-dsh-activity-inbox-plugin-0.1.0.tgz`。若希望从克隆的源码自行构建，请先在本仓库运行 `npm install`，再运行 `npm pack`。

```bash
cd /path/to/deepseek-harness
npm run dsh -- plugin --profile web add /absolute/path/to/chenjie1129-dsh-activity-inbox-plugin-0.1.0.tgz
npm run dsh -- --profile web
```

插件只把操作者偏好写入：

```text
$DSH_HOME/activity-inbox/state-v1.json
```

默认 RPC 权限为 `loopback`。只有在明确配置 Harness Host 的可信远程来源后，才应改用 `trusted-host`。

## v0.1 不包含

- 不包含 Slack / Discord 集成、推送通知、邮件摘要或移动端。
- 不包含多人已读状态、分派、团队权限或共享收件箱。
- 不生成 AI 摘要，只展示可确定复现的运行事实。
- 暂不支持跳转到单个事件；当前 Harness UI 提供的是任务级导航。
- 若持久化后端无法读取某个 Session，不能声称该 Session 已完成历史回填；面板会显示失败数量。

更多信息见 [架构说明](docs/ARCHITECTURE.md)、[测试说明](docs/TESTING.md) 和 [安全说明](SECURITY.md)。
