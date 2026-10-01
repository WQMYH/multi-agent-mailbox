# Qoder IDE Command Bridge

This VS Code-compatible extension exposes a small authenticated loopback command bridge for Qoder CN IDE. It requires the shared config documented in `modules/agent-qoder-ide/config.example.json` and starts no provider/model work by itself.

The first accepted command is `px.runTiger` for an explicit existing directory inside an explicit open workspace. Paradox Modding Toolkit 0.5.0 does not return Tiger completion, so the bridge reports invocation acceptance with unobservable completion. No command is automatically retried.

The source candidate also exposes fixed mappings for Qoder history activation and one current-page `sendText`. Commands are serialized per bridge instance. Every mutation requires the same store owner's Agent Core allocation and a physical peak check for its persistent request claim; page sends additionally persist a bounded message reservation before dispatch. This is not a second queue. Claims and message/Hook writes share one store lock. Admission physically retains room for the bounded final record and one same-sized same-directory atomic replacement, so accepted reservations keep enough capacity for later legal Hooks. On Windows, a transient named pipe holds the store lock; an in-process worker keeps the synchronous API and closes the pipe at the end of each operation. Process exit releases it without creating disk lock/candidate/recovery files. The previous 512-byte admission margin remains conservative. Under this gate, legacy lock files are removed only after their recorded PIDs are provably dead; confirmed orphan atomic helpers are removed and each schema-3 record's headroom is reconciled to the atomic old-or-new record. Live, malformed or otherwise unprovable ownership remains explicit backpressure. Other platforms return `LOCK_UNSUPPORTED`.

To observe provider input and replies, configure the workspace's existing `.qoder/settings.local.json` so both `UserPromptSubmit` and `Stop` run:

```text
"<absolute-node.exe>" "<installed-extension>/hook-collector.cjs" "<absolute-agent-qoder-ide.json>"
```

The collector reads one Hook event from stdin and stores only bounded correlation fields plus a reply preview. Exact duplicate submission evidence is idempotent; conflicting native attribution quarantines the record. A reply requires the same native session, transcript and non-empty request-set ID observed at prompt submission. Missing native request-set correlation is unsupported. Reads do not consume the record. Command return, the request marker, or Stop alone does not prove delivery completion or business completion.

The identity and local instance record advertise `capabilities.mutationOwnerBudget:true` only in the paired all-mutation budget implementation. The new client requires it in both the local record and authenticated live identity before mutations, while leaving read-only routes available. Installing this VSIX does not reload existing windows; validate a new paired isolated instance without closing or reloading user windows. Product versions remain diagnostic only.
