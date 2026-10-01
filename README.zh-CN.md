[English](README.md) | [简体中文](README.zh-CN.md)

# 多智能体信箱 · Multi-Agent Mailbox

[![CI](https://github.com/WQMYH/multi-agent-mailbox/actions/workflows/ci.yml/badge.svg)](https://github.com/WQMYH/multi-agent-mailbox/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853D.svg)](https://nodejs.org/)

让本机智能体通过统一的 **CLI 或 MCP 信箱**可靠传递消息。保留各智能体的模型、原生工具与产品队列；需要会话控制、Hook 或结果收集时，再配置专门化适配插件。

这里不是另一套智能体客户端，也不是全局调度器。**每个智能体不必安装专用插件**：能调用 CLI/MCP 即可使用通用信箱。Qoder、ZCode 即使已安装专用适配层，也可选择 mail 通道。

## 已有能力

- 持久化会话地址、联系人发现、显式收件人、关联回复。
- 只读预览与持久批次获取分开；处理后精确确认，不因读取自动消费。
- 稳定请求 ID、去重；不自动重放结果不明的外部动作。
- Core 只有 `agent_discover`、`agent_read`、`agent_act` 三个工具，CLI 对应 `discover/read/act`，模块按需加载。
- 登记代次、禁用/卸载检查、保留数据的生命周期。
- 每个真实持久队列 owner 默认 **50,000,000 字节**，可配默认值、单 owner 上限及可选总上限。同队列不因多个插件引用而重复计量；多个智能体共享 mail 数据库时共享该 owner 配额。
- Qoder 独立版、Qoder CN IDE、ZCode 桌面端的可选适配层。

## 已测智能体与兼容性

以下实机范围截至 **2026-10-01**，操作系统为 Windows。产品版本仅记录环境，**不是强制白名单**；先检查能力，在调用失效时再核对更新影响。

| 智能体 | 通用信箱实测 | 专用适配实测 |
| --- | --- | --- |
| Codex | Core 发信、收信、关联回复、精确确认 | 三工具 MCP 与同实现 CLI |
| pi | 原生 mail 工具；pi → Qoder → 同一 pi 会话闭环 | 不需要专用插件 |
| Qoder CN 独立版 | pi ↔ Qoder 闭环真实收信、回信 | 创建/发送、FIFO、多会话/多轮回传、崩溃后显式恢复 |
| ZCode CLI | **Codex ↔ 同一原生 CLI 会话**收信、回信、确认，无 Sharing Link | 使用原生命令工具，无需专用 mail 插件 |
| OpenClaw | 原生 mail 工具与关联回信；DeepSeek 下原生运行成功 | 不需要专用插件 |
| Qoder CN IDE | 可接入 CLI/MCP，尚未单独声明 IDE 原生 mail 闭环 | 认证窗口命令桥、当前页发送、对应回复/状态、页面切换观察 |

**其他智能体基本具备接口兼容条件**：能运行 Node CLI 或作为 MCP 客户端接入即可。未逐款实测，不将接口兼容当作全部产品认证。需要原生唤醒、会话定位或 Hooks 时可配备最小专门化插件；复用 Core/现有队列，不叠加第二套发送状态机。

通用 mail 是**拉取型信箱，不自动唤醒产品**。ZCode 无 link 测试是新原生 CLI 会话和显式接续；`agent-zcode` 对**桌面已有会话**的控制仍需 Sharing Link。两条通道分别标注。

## 最小安装：只用信箱

需要 **Node.js 24+**、本地文件系统及同一操作系统用户。Core/mail 不要求安装 Qoder、ZCode、Codex 桌面端，也不依赖 npm 包。

```powershell
git clone https://github.com/WQMYH/multi-agent-mailbox.git
cd multi-agent-mailbox
node modules/agent-core/src/cli.mjs install modules/agent-mail
node --input-type=module -e "import {queueOwnerId} from './modules/agent-mail/adapter.mjs'; console.log(JSON.stringify({ownerIds:[queueOwnerId()]}));" | node modules/agent-core/src/cli.mjs budget sync
```

安装和配额同步由操作者明确执行，邮件本身不能安装代码或扩大配额；保留原有配额/数据，登记后请保留模块路径。

向智能体提供 Core CLI 路径，或使用其原生 MCP 配置启动：

```text
node /absolute/path/to/multi-agent-mailbox/modules/agent-core/src/mcp-server.mjs
```

默认 registry 是 `~/.codex-agent-core/registry.json`。若另选登记文件，CLI 的 `--registry` 与 MCP 的 `AGENT_CORE_REGISTRY` 应指向同一绝对路径；`AGENT_MAIL_DB_PATH` 单独选择 mail 数据库，**换 registry 不等于换数据库**。

```powershell
'{"moduleId":"agent-mail"}' | node modules/agent-core/src/cli.mjs discover
'{"moduleId":"agent-mail","operation":"register","args":{"requestId":"my-stable-session-id","label":"my-agent"}}' | node modules/agent-core/src/cli.mjs act
```

保留返回的 `ownerId`、`target`、`consumers`；通过 `contacts` 选择精确地址，`send` 投递/回信，`inbox` 预览，`confirm_and_fetch` 获取/确认批次。对账复用原请求 ID，新消息使用新 ID。[完整协议](modules/agent-mail/README.md)。

## 按需安装原生适配

| 组件 | 用途 | 文档 |
| --- | --- | --- |
| `agent-core` | 公共 CLI/MCP、生命周期 | [Core](modules/agent-core/README.md) |
| `agent-mail` | 通用信箱 | [Mail](modules/agent-mail/README.md) |
| `agent-qoder` | 独立版控制与产品队列 | [Qoder](modules/agent-qoder/README.md) |
| `qoder-codex-bridge` | Qoder Hook、结果归属、回传 Codex | [回传](qoder-codex-bridge/README.md) |
| `agent-qoder-ide` + `qoder-ide-bridge` | 认证窗口、命令和当前页交互 | [IDE](qoder-ide-bridge/README.md) |
| `agent-zcode` | ZCode 桌面端原生远程控制 | [ZCode](modules/agent-zcode/README.md) |
| `zcode-codex-bridge` | ZCode → 固定 Codex 目标状态/通知 | [回传](zcode-codex-bridge/README.zh-CN.md) |

Codex 原生插件入口：

```powershell
codex plugin marketplace add WQMYH/multi-agent-mailbox
codex plugin add agent-core@codex-with-zcode
```

仓库/显示名称已更名，marketplace ID `codex-with-zcode` 与组件 ID 保留兼容。旧独立 `zcode-ops` 不再是默认入口；改用 Core 与对应模块，**不降级/清空旧队列、不盲目重放未知请求**。旧源码保留供历史/迁移使用。

## 发布与测试

可克隆源码或下载 [GitHub Release](https://github.com/WQMYH/multi-agent-mailbox/releases)。附件提供源码、Core/mail 包、可选回传 ZIP、IDE VSIX 和 SHA-256 校验文件。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

测试从 `scripts/` 构建 ZCode runtime，独立进程顺序运行公开离线测试；不会重跑付费模型实验。CI 使用同一入口。根 lockfile 的依赖留给旧 ACP 诊断，新 Core/mail 不需要它们。

[验收范围](docs/compatibility.md) · [发行说明](docs/releases/v0.2.0.md) · [贡献指南](CONTRIBUTING.md) · [安全边界](SECURITY.md)

首版是**同机、同操作系统用户**的信息传递。模块、registry 与 CLI 执行是受信任本机代码；邮件来源标签不是人类授权，收信不等于获准执行敏感动作。令牌、binding、Sharing Link、数据库和日志留在本机。跨电脑认证/网络服务与自动唤醒不在本版范围；源码、安装、原生执行、消费确认、业务完成分别记录。

[Apache-2.0](LICENSE) · [第三方材料](THIRD_PARTY_NOTICES.md)。
