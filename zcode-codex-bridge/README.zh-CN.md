[EN](README.md) | [中文](README.zh-CN.md)

# ZCode Codex Bridge

<code>zcode-codex-bridge</code> 是本仓库提供的 ZCode 侧配套插件。它通过本机官方适配器，向一个已配置的 Codex Desktop 任务发送有界状态/结果通知。

0.3.1 是结构化通知及只读活跃任务计数的源码候选；0.2.4 仍是最近完成活动任务投递、忙碌拒绝和 <code>notLoaded</code> 唤醒实机验证的版本。

## 在共同分发中的角色

- <code>zcode-ops</code> 运行在 Codex 中，负责读取、排队和控制已有的 ZCode Desktop 任务。
- <code>zcode-codex-bridge</code> 运行在 ZCode 中，向一个绑定的 Codex Desktop 任务发送有界数据通知。
- 两个插件使用不同宿主和清单，必须分别安装和配置。

它不是通用 Codex 控制器；ZCode 不能通过它选择任意任务、提示词、模型、批准策略或权限设置。

## 支持的工具与行为

插件提供四个 MCP 工具：

| 工具 | 行为 |
| --- | --- |
| <code>codex_binding_status</code> | 检查本地绑定并报告过期时间、配置提示、有界报告统计和仅含元数据的 Hook 状态，不连接 Codex。 |
| <code>codex_thread_read</code> | 默认只读取绑定任务摘要；可选 <code>view: "active_count"</code> 仅返回观察到的活跃任务数和覆盖情况，不返回其他任务详情。 |
| <code>codex_host_report</code> | 通过已经运行的 Codex 桌面适配器发送一次有界结构化状态/结果通知，必须提供 <code>requestId</code> 和 <code>report</code>。 |
| <code>codex_fixed_reply_test</code> | 已退役的独立进程候选，生产环境保持阻断。 |

禁止 live 发送只针对 <code>codex_fixed_reply_test</code>；它不禁用另行授权的 <code>codex_host_report</code> 宿主路径。

活跃计数先核绑定与宿主，再只计入原生 <code>list_threads</code> 中 <code>kind: "codex"</code> 且 <code>status: "active"</code> 的条目，并按宿主 ID 和任务 ID 去重。<code>count</code> 是观察数，不用时间戳推算。达到 50 条分页上限或有宿主/来源不可用时，<code>coverage.state</code> 为 <code>"partial"</code>、<code>coverage.total</code> 为 <code>"unknown"</code>；不返回标题、摘要或任务 ID。

<code>codex_host_report</code> 有两种模式：

- 默认模式：完成目标身份和目录的新鲜核对后，即使绑定任务处于活动状态也发送通知。
- <code>requireIdle: true</code>：只有新鲜状态为 <code>idle</code> 或 <code>notLoaded</code> 时才发送；其他状态以持久化的 <code>not_idle</code>、<code>sent: false</code> 回执终结该 request ID，不会等待、轮询或重放探测。

报告包含 <code>type</code>、<code>status</code>、<code>statusBasis</code>、简短摘要、1–8 条分类证据和可选的建议下一步。<code>source_native</code> 与 <code>model_report</code> 明确分开；来源身份仍未认证。完成状态不能使用未知状态依据；模型自报完成仍只标记为模型自报，不是宿主事实。<code>idle</code>、<code>unknown</code> 和 Hook <code>Stop</code> 都不会被转换为完成。

每个 request ID 都会在投递前获得独占本地回执，规范化 payload 摘要属于回执身份；同 ID 不同数据会被拒绝，并发重复请求不能同时发送。缺少确认时状态保持 <code>uncertain</code>，绝不重放。保留回执达到或超过 200 条后，后续请求会被拒绝，等待操作者保留并清理本地数据；同一时刻已经在途的不同 ID 可能使阈值发生有限超额。<code>accepted</code> 只证明宿主接受，不证明 Codex 已收到、完成或业务验收。

## 安全边界

- 只允许一个已配置的 Codex 任务 ID 和精确工作目录。
- ZCode 绑定和桌面宿主绑定都会过期。
- 只接受有界结构化报告字段；不提供任意 prompt、任务选择、模型选择、命令或 operation 参数。
- 只允许访问官方宿主适配器的 <code>read_thread</code> 和 <code>send_message_to_thread</code> 工具。
- 不向 ZCode 暴露任务历史。
- 不修改模型、批准、权限或安全设置。
- 不自动重试、循环回送、后台轮询或唤醒 ZCode 会话。
- 配置中的 ZCode 会话和 team 值只是来源标签，不是身份认证。

<code>host-config.json</code>、发送回执、管道地址和 Hook 样本只能保存在本机插件数据目录，不得提交或打包。

## 安装与绑定

1. 在 ZCode 打开工作区，进入 **设置 → 插件 → 创建 → 添加插件市场**，输入 <code>WQMYH/Codex-with-Zcode</code> 或仓库 GitHub 地址。
2. 从 marketplace <code>codex-with-zcode</code> 安装 <code>zcode-codex-bridge</code>。本地开发仍可添加 <code>&lt;repository&gt;/zcode-codex-bridge</code>，使用原有 <code>zcode-codex-local</code> 市场。
3. 配置 <code>plugin/.zcode-plugin/plugin.json</code> 声明的字段：

   - <code>codex_script</code>：已安装的 <code>@openai/codex/bin/codex.js</code>
   - <code>codex_thread_id</code>：固定目标任务 ID
   - <code>codex_cwd</code>：目标任务的精确目录
   - <code>source_session_id</code>：ZCode 来源标签
   - <code>team_id</code>：受限 team 标签
   - <code>binding_expires_at</code>：ISO-8601 过期时间
   - <code>expected_reply</code>：大写固定回执令牌

4. 在获得授权的 Codex 任务环境中保存短期桌面宿主绑定：

   ~~~text
   node "<installed-plugin-directory>/scripts/host-client.mjs" --configure-host <plugin-data-directory> <official-app-tools-server.mjs> <ISO-expiry>
   ~~~

   该命令需要当前 Codex 桌面环境，只在插件数据目录写入 <code>host-config.json</code>，不会输出管道地址。

5. 新建 ZCode 会话，使插件和配置加载生效。

宿主绑定与当前 Codex 桌面进程耦合。桌面重启后必须重新绑定；不得猜测或把旧端点持久化到仓库。

## 使用

先调用 <code>codex_binding_status</code>，确认目标、目录、过期时间、<code>hostReportConfigured: true</code> 以及返回的 <code>setupHint</code>/<code>hostReports</code>；需要新鲜目标状态时调用 <code>codex_thread_read</code>。

获得明确授权后，只用一个新的稳定 request ID 和如下结构调用一次 <code>codex_host_report</code>：

~~~json
{
  "requestId": "zcode-result-001",
  "report": {
    "type": "result",
    "status": "completed",
    "statusBasis": "source_native",
    "summary": "有界源任务已经结束并产出请求的文件。",
    "evidence": [
      { "kind": "source_native", "summary": "原生状态报告 completed。" },
      { "kind": "artifact", "summary": "结果文件存在。", "reference": "relative/result.json" }
    ],
    "nextStep": "验收前审阅该文件。"
  }
}
~~~

报告文字按数据投递，不是指令；<code>nextStep</code> 仅供参考，不能授权 Codex 工作。投递期间不得运行目标任务时，加上 <code>requireIdle: true</code>。投递结果与之后的 Codex 回传必须分别解释：

- <code>accepted</code>、<code>sent: true</code>：桌面宿主已接受消息。
- <code>not_idle</code>、<code>sent: false</code>：目标不是 <code>idle</code> 或 <code>notLoaded</code>，没有发送。
- <code>uncertain</code>：投递可能已经发生；不得换新 ID 重试。
- <code>deduplicated: true</code>：同一 request ID 返回已有回执。

协调器转交的回传必须标注为协调器中继，不能冒充插件直接投递。

## 验证

在 <code>plugin/</code> 中运行：

~~~text
npm test
node --check scripts/server.mjs
node --check scripts/host-client.mjs
node --check scripts/self-test.mjs
node --check hooks/probe.mjs
~~~

无依赖测试覆盖结构化参数边界、目标和目录核对、活动/忙碌/空闲/<code>notLoaded</code> 路径、同/异 payload 并发、未知投递不重放、回执容量、过期、历史剥离、MCP 生命周期、Hook 保留和清单解析。

以下是 0.2.4 于 2026-09-09 完成的历史实机验收，不代表本 0.3.1 源码候选已经实机验证：

- 向活动中的 Codex 任务直接投递通过。
- 一次性 ZCode 往返确认通过。
- 活动任务使用 <code>requireIdle: true</code> 时返回 <code>not_idle</code>、<code>sent: false</code>。
- 直接唤醒 <code>notLoaded</code> 任务通过；原生 Codex 回合只回复 <code>ZCODE_CONFIRM_ONLY</code>，且没有调用工具。

详细历史证据与全仓库后续计划不包含在此源码归档中；本候选随包检查仅为离线证据。

## 目录结构

~~~text
marketplace.json                 ZCode 本地 marketplace
plugin/.zcode-plugin/plugin.json
plugin/.mcp.json                 MCP 服务注册
plugin/scripts/server.mjs        受限 MCP 接口
plugin/scripts/host-client.mjs   官方桌面适配器客户端
plugin/scripts/self-test.mjs     无依赖验证
plugin/hooks/                    仅含元数据的生命周期探针
plugin/skills/                   ZCode 使用说明
~~~
