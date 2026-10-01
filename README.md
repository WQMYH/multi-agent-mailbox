[English](README.md) | [简体中文](README.zh-CN.md)

# Multi-Agent Mailbox · 多智能体信箱

[![CI](https://github.com/WQMYH/multi-agent-mailbox/actions/workflows/ci.yml/badge.svg)](https://github.com/WQMYH/multi-agent-mailbox/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853D.svg)](https://nodejs.org/)

A durable **local mailbox for agents**, with the same interface through CLI or MCP. Agents keep their own models, native tools and queues. Add optional product adapters only when native session control, Hooks or result collection is needed.

This is not another agent client or global scheduler. An agent does **not** need a dedicated plugin to send, read and acknowledge mail. Qoder and ZCode can use this generic channel too, even when their dedicated adapters are installed.

## Features

- Durable session addresses, contact discovery, explicit recipients and correlated replies.
- Read-only previews, persistent fetch batches and exact consumer acknowledgement.
- Stable request IDs and deduplication; uncertain external actions are not automatically replayed.
- Three shared MCP tools: `agent_discover`, `agent_read`, `agent_act`; matching `discover/read/act` CLI commands; lazy adapter loading.
- Registration revisions, disable/uninstall checks and preserved data.
- Capacity per real persistent queue owner: **50,000,000 bytes by default**, configurable defaults/owner limits and an optional global cap. References to the same queue are counted once.
- Optional native Qoder standalone, Qoder CN IDE and ZCode desktop adapters.

## Tested agents and compatibility

Native evidence is current through **2026-10-01**, on Windows. Product versions describe observations, not a version allowlist: inspect capabilities and investigate version changes when a route fails.

| Agent | Generic mailbox tested | Dedicated integration tested |
| --- | --- | --- |
| Codex | Send, receive, correlated reply and exact confirmation | Three-tool MCP and matching CLI |
| pi | Native mail tools; pi → Qoder → the same pi session | No dedicated plugin required |
| Qoder CN standalone | Real receive/reply in the pi ↔ Qoder mail loop | Session creation/send, FIFO, multi-session/multi-turn returns and explicit crash recovery |
| ZCode CLI | **Codex ↔ the same native ZCode CLI session**, receive/reply/confirmation, no Sharing Link | Uses its existing command tool; no mail-specific ZCode plugin |
| OpenClaw | Native mail tools and correlated reply; successful DeepSeek run | No dedicated plugin required |
| Qoder CN IDE | CLI/MCP-compatible; its own native mail loop is not separately claimed | Authenticated window/command bridge, current-page send, matching reply/status and observed page switching |

**Other agents are generally interface-compatible** if they can execute the Node CLI or use MCP. They are not individually certified by this table. A small specialized adapter can add native wakeup, session targeting or Hooks; reuse Core and the existing queue rather than another message state machine.

Mail is **pull-based**, not automatic product wakeup. ZCode's no-link test covers a new native CLI session with explicit resume. Control of an **existing ZCode desktop conversation** through `agent-zcode` still uses its Sharing Link. These are separate channels.

## Quick start: mailbox only

Requirements: **Node.js 24+**, a local filesystem and agents running as the same OS user. Core/mail needs no Qoder, ZCode, Codex Desktop or npm dependencies.

```powershell
git clone https://github.com/WQMYH/multi-agent-mailbox.git
cd multi-agent-mailbox
node modules/agent-core/src/cli.mjs install modules/agent-mail
node --input-type=module -e "import {queueOwnerId} from './modules/agent-mail/adapter.mjs'; console.log(JSON.stringify({ownerIds:[queueOwnerId()]}));" | node modules/agent-core/src/cli.mjs budget sync
```

Installation and capacity sync are explicit operator steps; messages cannot install modules or raise quotas. Existing allocations/data are preserved. Keep registered module paths available.

Give your agent the Core CLI path, or configure its native MCP client to launch:

```text
node /absolute/path/to/multi-agent-mailbox/modules/agent-core/src/mcp-server.mjs
```

The default registry is `~/.codex-agent-core/registry.json`. For another registry, use the same absolute `AGENT_CORE_REGISTRY` for MCP and `--registry` for CLI. `AGENT_MAIL_DB_PATH` selects the mail database separately: **changing the registry does not change the database**.

```powershell
'{"moduleId":"agent-mail"}' | node modules/agent-core/src/cli.mjs discover
'{"moduleId":"agent-mail","operation":"register","args":{"requestId":"my-stable-session-id","label":"my-agent"}}' | node modules/agent-core/src/cli.mjs act
```

Keep the returned `ownerId`, `target`, `consumers` for that logical session. Use `contacts` to choose an exact address, `send` for messages/replies, `inbox` for preview and `confirm_and_fetch` for fetch/ack. Preserve original request IDs when reconciling admission. [Full mail contract](modules/agent-mail/README.md).

## Optional integrations

| Component | Purpose | Guide |
| --- | --- | --- |
| `agent-core` | Shared CLI/MCP and module lifecycle | [Core](modules/agent-core/README.md) |
| `agent-mail` | Generic pull mailboxes | [Mail](modules/agent-mail/README.md) |
| `agent-qoder` | Standalone session control and its product queue | [Qoder](modules/agent-qoder/README.md) |
| `qoder-codex-bridge` | Optional Qoder Hooks, result attribution and Codex return | [Return plugin](qoder-codex-bridge/README.md) |
| `agent-qoder-ide` + `qoder-ide-bridge` | Authenticated IDE command/page bridge | [IDE](qoder-ide-bridge/README.md) |
| `agent-zcode` | ZCode desktop control via native remote mechanism | [ZCode](modules/agent-zcode/README.md) |
| `zcode-codex-bridge` | Fixed-target Codex status/notification from ZCode | [Companion](zcode-codex-bridge/README.md) |

Codex's native plugin entry:

```powershell
codex plugin marketplace add WQMYH/multi-agent-mailbox
codex plugin add agent-core@codex-with-zcode
```

The marketplace ID `codex-with-zcode` and component IDs remain compatible; the repository/display name has changed. The retired standalone `zcode-ops` is no longer the default marketplace entry. Use Core and register the modules you need; **do not downgrade, erase or blindly replay old queues**. Legacy source is retained for migration/history.

## Release and verification

Use a checkout or [GitHub Release](https://github.com/WQMYH/multi-agent-mailbox/releases). Attachments include source, Core/mail bundle, optional companion ZIPs, IDE VSIX and SHA-256 checksums.

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Tests rebuild ZCode runtime from `scripts/` and run public offline suites sequentially in separate processes. CI uses the same entry, without paid native-model experiments. Root dependencies are retained for legacy ACP diagnostics; the new Core/mail transport does not need them.

[Tested scope](docs/compatibility.md) · [Release notes](docs/releases/v0.2.0.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Security and scope

This release is **same-machine, same-OS-user** messaging. Registry files, installed adapters and CLI execution are trusted local code. Source labels are not authenticated human authority; receiving mail does not authorize protected actions. Keep tokens, bindings, Sharing Links, databases and logs local. Cross-machine authentication and automatic native wakeup are outside this release. Source, installation, native execution, consumer acknowledgement and business completion are separate states.

[Apache-2.0](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md).
