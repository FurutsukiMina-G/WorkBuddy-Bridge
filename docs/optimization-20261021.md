# WorkBuddy Bridge 0.2.0 优化与验收

本次以 [Qoder-Bridge](https://github.com/FurutsukiMina-G/Qoder-Bridge) 为功能参照，改动仅在 `workbuddy-bridge`。源码修改前备份位于私有 `.runtime/development/optimization-20261021-161204/`。

## 功能对照

| 能力 | WorkBuddy 0.2.0 |
|---|---|
| OpenAI Chat Completions、非流式、思考 SSE | 支持 |
| 规范 final 正文即时 SSE | 支持；跨块 JSON 转义和 UTF-16 代理对；输出冲突/截断以 error 结束 |
| 工具、批量工具、tool_choice、Schema 校验 | 支持；禁止 parallel_tool_calls 时拒绝多调用；整批校验后交付 |
| 会话隔离和续接 | 官方 SDK resume；身份、模型、公开窗口、effort 与预算隔离；完整语义前缀检查 |
| 重复上下文消耗 | 首轮完整，续接仅新增消息；未变 schema 引用；已验证工具调用只补宿主 ID，不重发大参数 |
| 两分钟相同请求重放 | 同一可路由会话内复用成功结果与调用 ID；本次上游 token 为 0；并发重复单飞 |
| 格式纠正与失败断路 | 最多额外 2 次，同模型/期限/单次输出预算；重复坏输出提前停止；相同失败请求短期断路 |
| 取消、总超时、排队与心跳 | 支持；取消排队请求不会中断占用者；SSE 心跳覆盖排队和会话等待 |
| token、缓存、tok/s、上下文压力 | 直接使用官方本轮用量；缓存未知时省略字段；日志和 `/metrics`/CLI 汇总 |
| 模型目录与推理等级/窗口 | 实时核实 WorkBuddy Flash；1M/400K/200K，low/high/max；无隐式模型回退 |
| 原生工具隔离、进程回收、认证维护 | 保留已有机制；每轮退出运行时，只保存受限数量私有 transcript |

Qoder 特有的 Credits/余额查询、按 Credits 反解缓存和 Pro 模型不能冒充 WorkBuddy 能力；WorkBuddy SDK 没有可靠积分字段，保持未知。Qoder 的 24k 推理 delta 启发式守卫未移植成“准确 token”守卫：本项目通过已映射的 max_tokens 与总超时限制单次推理，不把流式分块数当作官方 token。图片输入依旧不宣告并在模型请求前拒绝；温度等非核心参数仍不保证逐项映射。1M 是原生能力元数据，没有进行占满 1M 的压力测试。

## 上下文与隐私

官方 SDK 文档支持 [query 指定会话 resume](https://www.codebuddy.ai/docs/cli/sdk-sessions)。每次启动新的隔离进程、读取当前登录态，在本会话 SDK home 中恢复原生 transcript，因此不向同一模型会话重复注入完整宿主历史。继续保留官方顶层系统提示及桥接契约，宿主原始角色顺序在结构化消息中保持。

路由优先采用 `prompt_cache_key`；无显式会话键时，只通过桥已发出的工具 ID 路由。不会因两个用户说了相同文本而合并会话。历史角色、内容、工具 ID/参数、名字变化会重建；未发送给模型的 reasoning 等传输元数据不触发重建。首次或重建必须完整发送。工具定义改变时完整发送，未删除 schema 约束或截短工具说明。

默认保留最多 8 个 transcript，空闲 1 小时清理，没有空闲 SDK 进程。成功会话目录包含恢复需要的输入/输出，位于受限 ACL 的 `.runtime/sdk/`。失败会话清理；目录携带 worker PID 归属标记，后续进程只清理已确认退出的 worker 遗留目录。重启不恢复旧路由。常规请求日志只记录计数与哈希；格式错误原始回复沿用私有脱敏证据策略。

## 用量口径与发现的重复计数

真实两轮受控探针 `reports/usage-probe.json` 显示：首轮 assistant/result 输入均为 3857、输出 10；第二轮 assistant 输入 3978、输出 15，但 Result 输入 7835、输出 25。缓存读取第二轮 assistant 为 3840，而 Result 为 6784（2944 + 3840）。这验证了 **恢复会话后的 Result 是累计统计**。

因此优先按 assistant 的 response ID 去重并使用本轮字段，次选本轮 stream，只有缺少这些字段时才对累计 Result 差分。没有可靠基数就保持未知。失败时保留已获得用量，纠正尝试分别记录并合计一次。WorkBuddy input_tokens 是包含缓存类别的总输入；缓存创建不再次加入 prompt_tokens。SDK 报告金额 0 不等于免费；积分不推算。

本地成功/失败重放与上游缓存分别标记。首事件时延排除 role 空帧和心跳，正文、思考分别记录。上下文压力使用最后一次尝试的输入量，避免多次纠正的输入合计冒充当前窗口占用。tok/s 为官方输出 token / 首模型增量到完成的耗时，包含协议生成，不能等同于可见正文纯解码速度。

## 验证

离线套件覆盖：原有认证生命周期、完整 DSML/JSON、模型与工具隔离，以及新增的 resume/增量、历史变化、跨会话/模型/窗口/身份隔离、工具定义变化、大参数回声去重、本地重放 ID 稳定、并发取消、纠正和用量合计、错误流、逐字符 Unicode/转义、缺失缓存、累计 Result 差分、HTTP 参数前置拒绝与认证 metrics。

`npm.cmd run optimization:smoke` 在独立临时端口/会话执行有限次真实 WorkBuddy Flash 推理：宿主工具决策→随机宿主结果→最终回复、相同请求本地重放、1–120 长回复正文流。原生调用仅产生宿主决策，不实际执行工具。验收结果及每轮统计保存在本机 `reports/optimization-smoke-latest.json`。`npm.cmd run dsh:smoke -- read/pwsh` 另外检验真实 DSH 工具闭环，结果在 `reports/dsh-validation-*.json`。

2026-10-21 最终结果：55 项离线回归、全部 `.mjs` 语法检查、真实 SDK 验收、真实 DSH `read` 和 `pwsh` 均通过。DSH 两条测试合计 4 次模型请求，两个续接轮分别少注入 59,259 / 59,319 字符，工具 schema 均复用。Harness 已实际记录本轮未缓存输入、缓存读取和输出：read 最后一轮为 402 / 17,024 / 78 token；pwsh 最后一轮为 427 / 17,024 / 83 token（前两项合计才是完整 prompt）。SDK 独立流式样本首正文 9.36 秒、终态 10.70 秒。本次样本会受网络和上游排队影响，不作为固定性能承诺。

隔离生命周期测试中，worker 崩溃约 3.02 秒后恢复，supervisor 退出能回收 worker。真实 DSH 请求完成后的运行 worker `22296` 在本次检查时 SDK 后代进程数为 0，服务 `0.2.0` ready，active/queued 均为 0。相关报告为 `reports/lifecycle-test.json`、`reports/process-cleanup-validation.json`。原有 40 项测试没有产品故障，首次沙箱执行因本地网络/临时目录权限失败，获得正常访问权限后的基线 40 项全部通过。

字符节省是注入量的实测/精确差值，不是 token 或费用折扣承诺；缓存比例取该次样本的官方字段，不代表长期保证。离线故障模拟不等于真实上游纠错成功率，短时验证不等于多小时耐久测试。
