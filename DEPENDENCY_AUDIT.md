# Phase 1 dependency audit

2026-09-07 correction: ACP execution is suspended at the gateway. `handlers/session.js:247` hardcodes native creation to `yolo`; outer MCACP `operator` was not proof of native permission enforcement. The direct desktop-index write below is not the desktop application's creation workflow. Neither issue is fixed inside the dependency; create/load/send are blocked before invoking it until a replacement route is verified.

Audited on 2026-09-05 from `https://registry.npmjs.org`, without executing package lifecycle scripts.

| Package | Version | Verified `dist.integrity` |
| --- | --- | --- |
| `mcacp` | `0.1.3` | `sha512-j9gIPt8nT2QE5b3rzI7+4zasvBqk+sgmjBgcGwkgSmbf/6k9IvraPH+f3auienevLJDDfNEhjdCWi/VUYZ3DEw==` |
| `zcode-acp-server` | `0.21.0` | `sha512-1lVkw5DoHG8llqTDUrtLmIPuaehxDz0MtcQ8+k7n7lRu4pAqGU14XGWPjXtYcnRgmGqtjKkMUgZyy/WWek4uZQ==` |

The downloaded tarballs reproduced those SHA-512 values. Neither direct package declares an install lifecycle script; the lockfile records transitive packages.

- MCACP bundles registry search/install/uninstall/upgrade and merges user/system agent configuration. The gateway hides those tools, fixes lifecycle calls to `agentId: "zcode"`, and uses an empty registry list.
- `zcode-acp-server` reads ZCode's configured credentials from `(HOME || USERPROFILE)/.zcode/v2/config.json` and starts local `zcode app-server --stdio`. This plugin neither copies nor logs those values. Keep ACP credentials and native CLI session storage separate when configuring child-only environment overrides.
- Correction from the 2026-09-07 profile investigation: the dependency's `tasks-index.js` directly opens the adjacent `tasks-index.sqlite` to register newly created sessions and update titles. Its initial `completed` index value is not a runtime completion signal. The gateway does not write this database itself, but the end-to-end creation path is not SQLite-write-free.
- Its remote and quota features are not used: the configuration uses only `server`, clears remote variables, sets `ZCODE_ACP_REMOTE=0`, and supplies no remote token.
- MCACP's Windows transport uses `shell: true` and emits Node's `DEP0190` warning. The configured agent command is the fixed token `node` with fixed package arguments; workspace paths travel only as JSON-RPC data, never as shell arguments.

This is a direct-package static review, not a claim about ZCode's own network behavior or every transitive package. Install only with `npm ci --ignore-scripts`.

The status projection starts the audited local `zcode-acp-server` with fixed arguments and uses its native `session/list` request. It returns session id, workspace, title, and update time; it does not open ZCode's SQLite database or request message content.

Completion receipts are generated locally and appended only to prompts explicitly sent through this bridge. Only assistant-message text contributes to a bounded reply suffix. A successful `complete`/`end_turn` plus a matching final receipt records an agent completion claim. Missing receipts never imply interruption; `complete` still establishes that the turn ended.

The envelope retains the raw result and interprets MCACP `update`, `permission_request`, `complete`, and `error` fields. The actual observed failure is `type: "error", message: "Internal error"`; `turn.failed` in backend stderr is not the MCP event schema. MCP read errors are not promoted to agent terminal failures. Authentication warnings and request failures observed together do not establish causation.
