# agent-zcode

The v1 ZCode desktop module exposes the existing ZCode tools through
`describe()` and `call()`, with target identity `zcode-desktop`.

Run `node build.mjs` to create the self-contained `runtime/` package. The
build copies the current queue/remote implementation; it does not create a
second hand-maintained source of truth or add global MCP tools.

Core-backed `zcode_send` uses the queue's persisted path-derived owner ID,
checks its shared byte allocation inside the SQLite write transaction, and
returns one Core-validated receipt per target alongside the legacy result.
Owner acceptance means only a durable queue row; provider acceptance starts
unknown, and a batch does not claim cross-owner atomicity. Direct non-Core
calls keep the queue's existing internal limits without claiming Core budget.
Core defaults to 50,000,000 bytes per registered persistent owner, with configurable
owner/default limits and an optional global cap. Explicit legacy 20,000,000-byte
and 200,000,000-byte configurations keep their original allocations. ZCode's separate 20M disk / 9M database / 7M working limits are
unchanged; the stricter applicable gate controls admission. Workspace-mode
`zcode_send` durably records creation before calling native `createTask`, binds
its real `sess_*` ACK, then sends the first message. Unknown effects never replay.

This desktop control channel still requires a Sharing Link. ZCode can instead
use the generic [agent-mail](../agent-mail/README.md) CLI/MCP without that link;
the same-session native CLI receive/reply/confirmation path was tested. It does
not attach to an existing desktop conversation or provide automatic wakeup.
See [tested scope](../../docs/compatibility.md).

Registration and files are separate lifecycle actions:

- Disabling/removing the module registration stops new base dispatches but
  leaves module files and the legacy plugin untouched.
- Removing this module package is a separate uninstall action; it does not
  delete the ZCode queue database or stop processes owned by other modules.
- Uninstalling the legacy Codex plugin is a separate action and is not part of
  this module.
