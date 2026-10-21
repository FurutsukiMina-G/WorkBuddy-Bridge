# WorkBuddy Bridge

源码与依赖在仓库根目录。运行数据在 `.runtime/`，请求日志与验收报告在 `reports/`，`python scripts/package-source.py` 生成的源码包在 `releases/`；三者只保存在本机，不进入版本库。

独立常驻的 WorkBuddy → DeepSeek Harness 桥。正式推理使用腾讯官方 `@tencent-ai/agent-sdk@0.3.286` 驱动本机 WorkBuddy 运行时，不依赖 `dsh-connect-workbuddy` 插件进程。

`0.2.0` 对齐 QoderBridge 的 Flash 核心桥接路径：正文和思考实时 SSE、官方 token/缓存统计与汇总、原生会话恢复、新增消息与未变工具 schema 去重、两分钟本地结果重放、最多两次请求内格式纠正及相同失败请求断路。工具参数始终整批通过完整 JSON Schema 校验后交付；不执行本机工具、不切模型。具体口径和功能对照见 [优化与验收说明](docs/optimization-20261021.md)。

`0.2.1` 根据新增 18 个实际请求修复完整 JSON 前多一个 `<` 导致的无效重生成；只移除这个已观测的单字符，完整 JSON、整批 Schema、tool_choice 与多通道一致性仍需全部校验。参数错误的纠正提示指出具体缺失字段，仅重发受影响工具的完整 schema；一般格式纠正引用已有 schema。每次拒绝记录脱敏摘要与有界私有证据，`metrics` 新增本地格式修复数和纠正轮 token 合计。参见 [新增使用数据复核](docs/usage-review-20261021.md)。

保留 `0.1.1` 的完整 JSON/DSML 解码、多文本块收集、冲突检测和私有脱敏失败证据。不会从解释文字或代码示例中抽取调用。错误响应保留已报告用量；`/health` 的 `provider.sdk.lastFailure.evidenceFile` 给出私有证据路径。

## 运行方式

```text
DSH 首轮完整上下文 / 后续新增消息与变化的工具 schema
  → 127.0.0.1:8647/v1/chat/completions
  → 官方 Agent SDK + 已安装的 WorkBuddy runtime
  → WorkBuddy CN / deepseek-v4.1-flash
  → JSON / 完整 DSML 决策 + 完整 JSON Schema 校验
  → 标准 tool_calls → DSH 执行工具 → 下一轮
```

保持官方运行时的默认系统提示，追加桥接协议；DSH 原始消息按顺序放进结构化输入。桥不把 DSH 系统提示替换为 WorkBuddy 的顶层系统提示，不自行执行文件、Shell、MCP 或子代理。SDK 内的原生工具有显式禁用列表、权限拒绝与 `PreToolUse` 停止钩子。

## 安装与使用

Windows 需要 Node.js 22.19+、已安装且已登录的 WorkBuddy。源码使用固定依赖与 lockfile：

```powershell
git clone https://github.com/FurutsukiMina-G/WorkBuddy-Bridge.git
cd WorkBuddy-Bridge
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run check
npm.cmd run models
& .\scripts\install-task.ps1
npm.cmd run status
npm.cmd run metrics -- --limit 100
npm.cmd run dsh:configure
```

安装任务名 `WorkBuddyBridge-8647`，当前用户登录时启动，无运行时长限制，电池供电时继续。独立 supervisor 负责进程退出后的退避重启，20 秒检查一次有认证的本机健康接口，连续 3 次不可达才重启自己的 worker。上游限流或登录失效不会触发反复重启。

Windows worker 与 SDK launcher 使用已安装 WorkBuddy 的原生 Job Object，把后代进程纳入关闭时回收。launcher 在收到正式终态后给运行时 1 秒退出时间，再回收本次进程；worker 崩溃时也会回收它的后代。此处修复了真机复现的 SDK 请求结束后约 140 MB 运行时进程残留问题。正式服务连续 5 次请求完成后已核实无残留 SDK 子进程。

DSH 模型分组：`WorkBuddy Bridge · SDK`，provider：`workbuddybridge`。提供 `workbuddy-deepseek-flash`（1M）、`-400k`、`-200k`，推理 `low/high/max`。小窗口是 DSH 的上下文预算，WorkBuddy 原生窗口仍为 1M。配置脚本只注册模型，不改变默认模型或现有会话选择。

```powershell
& .\scripts\start-server.ps1
& .\scripts\stop-server.ps1
npm.cmd run smoke
npm.cmd run dsh:smoke -- read
npm.cmd run dsh:smoke -- pwsh
node scripts/dsh-result.mjs read
node scripts/lifecycle-test.mjs
node scripts/soak.mjs  # 有限 6 小时，每 30 分钟一个真实 Flash 请求
```

`soak` 会产生真实模型用量，不自动无限续跑。结果写入 `reports/soak.json`。模拟时间推进测试不等同于真实 6 小时耐久测试。

## 11128 与稳定性边界

11128 是上游渠道/请求校验，进程保活和刷新 token 无法单独解决它。本实现使用官方 SDK 和 WorkBuddy 自己的请求生成流程，避免沿用插件的手工 chat HTTP 转发。已用包含真实 DSH 系统提示与原生工具清单的两轮任务验证；不承诺腾讯以后更改渠道规则时仍永久可用。

遇到 11128 会保留明确的 `workbuddy_11128` 错误，不把它冒充登录过期，不盲目重试、不切账号、不切模型。可以先用 WorkBuddy 官方客户端确认同一模型的可用性，再查看 `npm.cmd run status` 的脱敏 SDK 诊断。

每个请求重新创建 SDK 进程并读取登录态，同一宿主会话通过官方 `resume` 恢复私有 transcript，只注入新增消息；不保留空闲认证子进程。完整宿主上下文仍由 DSH 持有。历史改写/压缩、身份、模型、窗口或 effort 变化会隔离或重建上下文。默认最多 8 个 transcript，空闲 1 小时清理；重启后不恢复路由，已退出 worker 留下的带归属标记目录会清理。每分钟维护认证；到期前 10 分钟单飞刷新，原子保存私有缓存。真实登录撤销或刷新 token 失效仍需要重新登录。

## 配置

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `WORKBUDDY_PORT` | `8647` | 固定回环端口；改变后需重新注册 DSH |
| `WORKBUDDY_MODEL` | `deepseek-v4.1-flash` | 必须精确存在于实时 WorkBuddy 目录，并确认 DeepSeek Flash 与工具能力 |
| `WORKBUDDY_CLI` | 本机 Program Files 下的 `codebuddy-lite-wb.mjs` | 官方 WorkBuddy 运行时入口 |
| `WORKBUDDY_AUTH_FILE` | WorkBuddy 的 live `workbuddy-desktop.info` | 只读，不扫描历史登录备份 |
| `WORKBUDDY_TIMEOUT_MS` | `300000` | 排队和整轮请求合并的超时 |
| `WORKBUDDY_CONCURRENCY` | `3` | 并发上限；排队上限 32 |
| `WORKBUDDY_MAX_SESSIONS` | `8` | 原生会话 transcript 数量上限，不等于空闲进程数 |
| `WORKBUDDY_SESSION_IDLE_MS` | `3600000` | 空闲 transcript 清理期限 |
| `WORKBUDDY_REPLAY_MS` | `120000` | 同一已成功请求的本地重放时限；0 关闭 |
| `WORKBUDDY_DECISION_RETRIES` | `2` | 格式错误最多额外纠正次数；0 关闭；不重试渠道、认证、权限、取消或预算错误 |
| `DSH_CONNECTION_FILE` | 无 | 可选已有 DSH RPC 缓存，仅在核实进程/监听归属后使用 |
| `DSH_LAUNCH_LOG` | DSH 启动日志 | 新的 DSH 登录地址来源，同样先验证端口归属 |

所有 API（含 `/health`）都需要 `.runtime/bridge-key` 中的本机 Bearer key。绑定仅 `127.0.0.1`，拒绝浏览器 Origin 和异常 Host。不要把本机 key 填到 WorkBuddy 上游。

## 数据与用量

`.runtime/` 保存本机 key、私有刷新缓存、会话 SDK home 和恢复所需 transcript（包含模型输入/输出），安装脚本把目录 ACL 限制到当前用户与 SYSTEM。失败会话立即清理，成功 transcript 按空闲期限或淘汰清理，并延迟补清理运行时退出日志。`reports/requests.ndjson` 只保存请求 ID、模型、状态、时延、SDK 用量及上下文去重的计数/哈希，不保存输入、回复或工具参数。决策解码失败时，`.runtime/decision-errors/` 额外保存 SDK 已生成的响应与用量，关联同一请求 ID，不保存请求、登录配置或环境变量，已知凭据会被遮盖；健康接口仅显示输出长度、哈希和私有证据路径。DSH 原生验收脚本只导出它新建的测试会话。

Token 优先使用 assistant 的本次响应用量，其次使用本轮 stream 字段；**原生 resume 的 `Result.usage` 是会话累计数**，只能差分兜底，不能逐轮相加。WorkBuddy 的 `input_tokens` 已包含缓存读取/创建，不再次相加。缓存缺失保持未知；本地重放报告 0 本次模型 token，并标明来源，不算上游缓存命中。SDK `total_cost_usd:0` 不被当作免费，积分保持未知。规范 final.content 字符串可在终态前增量解码交付，JSON 转义和 Unicode 跨块处理；非规范输出在完整校验后交付，工具批次完整校验后交付。错误流不发送虚假的成功终态。

`npm.cmd run metrics -- --limit 100` 汇总最近日志；带认证的 `/metrics` 汇总 worker 启动后最近 1000 个请求。包含输入/输出、缓存读写及命中比例、首正文/思考时延、tok/s、纠正次数、重放数、上下文省去字符数；省去的字符不是已结算费用。`npm.cmd run optimization:smoke` 会进行有限次真实 Flash 验收，产生模型用量；`node scripts/usage-probe.mjs` 对照两轮原始 SDK 用量字段。

`node scripts/audit-usage.mjs --since 2026-10-21T09:29:05.413Z` 只读审计指定 UTC 时刻后的已有记录，不调用模型。格式纠正轮的私有输出保存在 `.runtime/rejected-decisions/`，已知凭据脱敏；只保留本模块生成的最近最多 32 个文件、合计最多 8 MiB，单份超过 1 MiB 时仅保留摘要。常规请求日志只有错误分类、计数/哈希和私有证据路径。历史终态错误目录 `.runtime/decision-errors/` 保持原有证据。

SDK 决策输入目前支持文本任务。图片输入未在 DSH 模型目录宣告，温度等非核心 Chat Completions 参数不保证 SDK 会逐项支持。工具参数完整校验失败时明确报错，不自动消耗多轮重试。

## 来源

参考 [Qoder-Bridge](https://github.com/FurutsukiMina-G/Qoder-Bridge) 的本地服务、DSH RPC 和 JSON 决策结构。DSH 端口归属验证辅助脚本从该项目复用。

独立 vendor 模块固定取自 `dsh-connect-workbuddy@4.13.0`，仅调用登录字段解析/解密、刷新与实时模型目录辅助方法；不运行它的 DSH 插件、shim、账号池、静态模型回退或聊天请求改写。保留其 MIT 许可证和第三方声明。原模块 SHA-256：`2338f4a38e3e8aa17b8fd23e5dcdfbeedb6ff86d2ca505e6915458931449d02b`。

- [腾讯官方 Agent SDK 文档](https://www.codebuddy.ai/docs/cli/sdk)
- [dsh-connect-workbuddy 源码](https://github.com/dingminhua/dsh-connect-workbuddy)
- 本机官方 WorkBuddy `cli/product.json` 将 `copilot.tencent.com` 声明为官方端点与认证域；模型请求使用已核实的 `/v2/chat/completions` 形态。
