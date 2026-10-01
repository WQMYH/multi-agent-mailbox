[EN](README.md) | [中文](README.zh-CN.md)

# ZCode Codex Bridge

<code>zcode-codex-bridge</code> is the ZCode-side companion plugin in this repository. It sends bounded status/result notifications to one configured Codex Desktop task through the official local adapter.

Version 0.3.1 is a source candidate for structured notifications and a read-only active-task count. Version 0.2.4 remains the latest live-tested build for active-task delivery, busy-task refusal, and <code>notLoaded</code> wake-up.

## Role in the joint distribution

- <code>zcode-ops</code> runs in Codex and reads, queues, and controls existing ZCode Desktop tasks.
- <code>zcode-codex-bridge</code> runs in ZCode and sends bounded data notifications back to one bound Codex Desktop task.
- The two plugins use different hosts and manifests. Keep them installed and configured separately.

This plugin is not a general Codex controller. ZCode cannot choose an arbitrary task, prompt, model, approval policy, or permission setting through it.

## Supported tools and behavior

The plugin exposes four MCP tools:

| Tool | Behavior |
| --- | --- |
| <code>codex_binding_status</code> | Checks the local binding and reports expiry, setup guidance, bounded report counts, and metadata-only Hook state. It does not contact Codex. |
| <code>codex_thread_read</code> | By default, reads only the bound task summary. Optional <code>view: "active_count"</code> returns an observed count and coverage, never other task details. |
| <code>codex_host_report</code> | Sends one bounded structured status/result notification through the already-running Codex desktop adapter. <code>requestId</code> and <code>report</code> are required. |
| <code>codex_fixed_reply_test</code> | Retired independent-process candidate; remains blocked in production. |

The live-send block applies only to <code>codex_fixed_reply_test</code>. It does not disable the separately authorized <code>codex_host_report</code> route.

The active-count view checks the fixed binding and host first, then counts only native <code>list_threads</code> entries with <code>kind: "codex"</code> and <code>status: "active"</code>, deduplicated by host ID and task ID. Its <code>count</code> is observed, not inferred from timestamps. <code>coverage.total</code> is <code>"unknown"</code> and <code>coverage.state</code> is <code>"partial"</code> when the 50-entry page limit is reached or a host/source is unavailable; no titles, summaries, or task IDs are returned.

<code>codex_host_report</code> has two modes:

- Default: after a fresh identity and directory check, send the notification even when the bound task is active.
- <code>requireIdle: true</code>: send only when the fresh status is <code>idle</code> or <code>notLoaded</code>. Any other status durably consumes that request ID with a <code>not_idle</code>, <code>sent: false</code> receipt; the plugin does not wait, poll, or replay the probe.

The report contains <code>type</code>, <code>status</code>, <code>statusBasis</code>, a short summary, 1–8 typed evidence items, and an optional proposed next step. <code>source_native</code> and <code>model_report</code> stay distinct; source identity remains unauthenticated. A completed report cannot use an unknown status basis. Model-reported completion remains labeled as a model self-report, not a host fact. <code>idle</code>, <code>unknown</code>, and Hook <code>Stop</code> are never converted to completion.

Every request ID gets an exclusive local receipt before dispatch. Its normalized payload digest is part of the identity, so the same ID with different data is rejected and concurrent duplicates cannot both send. A missing acknowledgement remains <code>uncertain</code> and is never replayed. At or above 200 retained receipts, later requests are refused until the operator preserves and cleans local data; a simultaneous distinct-ID burst can exceed the threshold only by its already in-flight records. <code>accepted</code> proves host acceptance only; it does not prove Codex receipt, completion, or business acceptance.

## Safety boundary

- One configured Codex task ID and exact working directory.
- Expiring ZCode binding and expiring desktop-host binding.
- Structured bounded report fields only; no raw prompt, task selector, model selector, command, or operation parameter.
- Only the official host adapter's <code>read_thread</code> and <code>send_message_to_thread</code> tools are reachable.
- No task history is exposed to ZCode.
- No model, approval, permission, or security-setting changes.
- No automatic retries, return loops, background polling, or ZCode-session wake-up.
- Configured ZCode session and team values are provenance labels, not authenticated identities.

<code>host-config.json</code>, send receipts, the pipe address, and Hook samples belong only in the local plugin data directory. Never commit or package them.

## Install and bind

1. In ZCode, open a workspace, then **Settings → Plugins → Create → Add marketplace**. Enter <code>WQMYH/Codex-with-Zcode</code> or its GitHub URL.
2. Install <code>zcode-codex-bridge</code> from marketplace <code>codex-with-zcode</code>. For local development, adding <code>&lt;repository&gt;/zcode-codex-bridge</code> still uses the existing <code>zcode-codex-local</code> marketplace.
3. Configure the fields declared in <code>plugin/.zcode-plugin/plugin.json</code>:

   - <code>codex_script</code>: installed <code>@openai/codex/bin/codex.js</code>
   - <code>codex_thread_id</code>: fixed destination task ID
   - <code>codex_cwd</code>: exact destination task directory
   - <code>source_session_id</code>: ZCode provenance label
   - <code>team_id</code>: bounded team label
   - <code>binding_expires_at</code>: ISO-8601 expiry
   - <code>expected_reply</code>: uppercase fixed reply token

4. From the authorized Codex task environment, save a short-lived desktop-host binding:

   ~~~text
   node "<installed-plugin-directory>/scripts/host-client.mjs" --configure-host <plugin-data-directory> <official-app-tools-server.mjs> <ISO-expiry>
   ~~~

   The command requires the current Codex desktop environment and writes only <code>host-config.json</code> under the plugin data directory. It does not print the pipe address.

5. Start a new ZCode session so the plugin and configuration are loaded.

The host binding is coupled to the current Codex desktop process. Recreate it after a desktop restart; never guess or persist an old endpoint in the repository.

## Use

Start with <code>codex_binding_status</code>. Confirm the destination, directory, expiry, <code>hostReportConfigured: true</code>, and the returned <code>setupHint</code>/<code>hostReports</code> state. Use <code>codex_thread_read</code> when a fresh target status is needed.

For an explicitly authorized notification, call <code>codex_host_report</code> once with a new stable request ID and a report shaped like this:

~~~json
{
  "requestId": "zcode-result-001",
  "report": {
    "type": "result",
    "status": "completed",
    "statusBasis": "source_native",
    "summary": "The bounded source task ended and produced the requested artifact.",
    "evidence": [
      { "kind": "source_native", "summary": "Native status reported completed." },
      { "kind": "artifact", "summary": "Result file exists.", "reference": "relative/result.json" }
    ],
    "nextStep": "Review the artifact before acceptance."
  }
}
~~~

Report text is delivered as data, not as instructions. <code>nextStep</code> is informational and never authorizes Codex work. Add <code>requireIdle: true</code> when delivery must not occur during an active turn. Interpret the result separately from any later Codex reply:

- <code>accepted</code>, <code>sent: true</code>: the desktop host accepted the message.
- <code>not_idle</code>, <code>sent: false</code>: the target was not <code>idle</code> or <code>notLoaded</code>; nothing was sent.
- <code>uncertain</code>: dispatch may have happened; do not retry with a new ID.
- <code>deduplicated: true</code>: the same request ID returned its existing receipt.

If a coordinator relays a reply, label it as a coordinator relay. Do not present it as direct plugin delivery.

## Verification

From <code>plugin/</code>:

~~~text
npm test
node --check scripts/server.mjs
node --check scripts/host-client.mjs
node --check scripts/self-test.mjs
node --check hooks/probe.mjs
~~~

The dependency-free test covers structured argument bounds, target and directory checks, active/busy/idle/<code>notLoaded</code> paths, same/different-payload concurrency, uncertain delivery without replay, receipt capacity, expiry, history stripping, MCP lifecycle, Hook retention, and manifest parsing.

Historical 0.2.4 live acceptance completed on 2026-09-09; it does not validate this 0.3.1 source candidate:

- Direct delivery to an active Codex task passed.
- One-time ZCode round-trip acknowledgement passed.
- <code>requireIdle: true</code> returned <code>not_idle</code>, <code>sent: false</code> for an active task.
- Direct <code>notLoaded</code> wake-up passed; the native Codex turn replied only with <code>ZCODE_CONFIRM_ONLY</code> and used no tools.

The detailed historical evidence record and project roadmap are outside this source archive. The packaged checks for this candidate are offline only.

## Layout

~~~text
marketplace.json                 ZCode local marketplace
plugin/.zcode-plugin/plugin.json
plugin/.mcp.json                 MCP server registration
plugin/scripts/server.mjs        bounded MCP surface
plugin/scripts/host-client.mjs   official desktop-adapter client
plugin/scripts/self-test.mjs     dependency-free verification
plugin/hooks/                    metadata-only lifecycle probe
plugin/skills/                   ZCode usage instructions
~~~
