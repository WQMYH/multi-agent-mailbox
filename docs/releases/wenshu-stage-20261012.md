# Post-Core stage candidate — 2026-10-12

This stage adds native mail receiver notifications, the shared post-core-mail skill, Yuan native-local Codex creation, QoderWake scoped native Session control, and Chat host/tunnel recovery. Existing queue ownership, retained messages, exact acknowledgements and unknown-request protections remain in place. See [accepted scope](../compatibility.md).

## Message selection correction

The earlier Yuan selector used one process-global selection: a second select replaced the first token (P1), and a mismatched send cleared a later valid selection (P2). The independently reviewed source3 correction is included in this candidate. It retains independent one-shot selections in a bounded map, rejects new selections at 256 pending entries, and leaves unrelated entries intact on mismatched sends. Restart loses pending selections; existing unknown dispatch records remain protected against replay. Source/offline acceptance of this correction is separate from installation and live native acceptance.

## Distribution

Source packages contain code, portable fixtures and redacted documentation. They exclude private plans, runtime state, installed configuration, transcripts, raw native evidence, personal paths and real session/device identifiers. Legacy ACP diagnostics use the operator's native environment and require their existing ZCode executable to be available; machine-specific executable/home overrides are no longer distributed.

Offline CI discovers both `.test.mjs` and `-test.mjs` suites, including the Chat read/inventory/events and companion expiry checks. Passing offline CI does not resolve the selection gate or establish a new native acceptance.
