# Tested scope — 2026-10-01

Windows/Node.js 24+ native observations are recorded here, not a product-version allowlist. Other CLI/MCP-capable agents have the same interface; their native integration is verified separately.

| Observation | Accepted scope |
| --- | --- |
| Core/mail | Shared CLI/MCP routing, receipt validation, lazy loading, registration invalidation, physical-owner budget/backpressure, stable routes, batches, exact ack and deduplication |
| pi → Qoder → same pi | Native mail commands and correlated return; no Sharing Link |
| Codex ↔ ZCode CLI 0.16.9 | New native session registered its mailbox, explicitly resumed the same session, fetched real mail and authored a correlated reply; five native command calls succeeded; both subscriptions confirmed |
| OpenClaw 2026.9.3 | Real mail tools/reply/confirmation; subsequent DeepSeek run succeeded. Prior MiniMax cleanup failure is not relabeled successful |
| Qoder standalone | Creation/send, overlapping FIFO, multiple bindings, subsequent turns, strict completed-turn attribution and explicit same-generation recovery after real worker exit |
| Qoder CN IDE | Authenticated window/workspace, command routing, current-page input/reply/status, actual pre-send A→B page switch and mutation-owner budget admission |
| ZCode desktop | Native inspection/sends, first-message creation observations, fixed-target Codex return and partial active-count coverage |

Mail addresses are durable pull routes, not presence or automatic wakeup. Qoder/ZCode may select mail even with dedicated adapters installed. Mail never mirrors an accepted product message or silently retries an uncertain native send through another channel.

ZCode CLI mail is link-free; existing desktop session control still uses Sharing Link. IDE control is page-level, not atomic native-session targeting; a pre-switch observation does not certify simultaneous click races. Explicit recovery does not prove autonomous restart or every terminal state. Partial active counts do not establish complete inventory/global idleness.

The ZCode CLI test first hit a bundled provider-path resolver miss before any session/model/tool execution. Supplying the existing bundled provider path only to the isolated child corrected startup; credentials/models were not replaced.

Public offline checks run through `npm test`. Native events and queue records were reconciled locally. Personal transcripts, live bindings and raw logs are not distributed. [Component guides](../README.md#optional-integrations).
