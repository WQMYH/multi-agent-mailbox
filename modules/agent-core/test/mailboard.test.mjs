import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { ModuleRegistry } from '../src/registry.mjs';
import { readMailboard, MAILBOARD_URI } from '../src/mailboard.mjs';
import { startDashboard } from '../src/dashboard.mjs';
import { queueOwnerId } from '../../agent-mail/adapter.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mailRoot = join(root, '..', 'agent-mail');
const xss = '<img src="https://example.invalid/leak" onerror="globalThis.stolen=true">';
function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'agent-mailboard-'));
  const registryPath = join(temporary, 'registry.json'), dbPath = join(temporary, 'queue.sqlite');
  const previous = process.env.AGENT_MAIL_DB_PATH;
  process.env.AGENT_MAIL_DB_PATH = dbPath;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_MAIL_DB_PATH;
    else process.env.AGENT_MAIL_DB_PATH = previous;
    assert.ok(temporary.startsWith(join(tmpdir(), 'agent-mailboard-')));
    rmSync(temporary, { recursive: true, force: true });
  });
  const core = new ModuleRegistry({ registryPath });
  core.install(mailRoot);
  core.initializeMessageBudget([queueOwnerId(dbPath)]);
  return { core, temporary, registryPath, dbPath,
    env: { ...process.env, AGENT_CORE_REGISTRY: registryPath, AGENT_MAIL_DB_PATH: dbPath, AGENT_CORE_UI: '1' } };
}
async function seed(f) {
  await f.core.agentAct({ moduleId: 'agent-mail', operation: 'send', args: {
    requestId: 'board-request', source: { moduleId: 'codex', address: 'test-source' }, body: xss,
    targets: ['alpha', 'beta'].map(address => ({ target: { moduleId: 'agent-mail', address }, consumers: ['reader'] }))
  } });
}
const bytes = directory => Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name)).toString('base64')]));
async function mcp(f, messages, ui = '1', capabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }) {
  const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    capabilities
  } };
  const child = spawn(process.execPath, [join(root, 'src', 'mcp-server.mjs')], {
    env: { ...f.env, AGENT_CORE_UI: ui }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const replies = [], queue = [initialize, ...messages];
  let stderr = '';
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => {
        try { assert.equal(code, 0, stderr); assert.equal(replies.length, messages.length + 1); resolve(); }
        catch (error) { reject(error); }
      });
      const next = () => queue.length ? child.stdin.write(JSON.stringify(queue.shift()) + '\n') : child.stdin.end();
      lines.on('line', line => {
        try {
          const reply = JSON.parse(line);
          if (!Object.hasOwn(reply, 'id')) return;
          replies.push(reply); next();
        } catch (error) { child.kill(); reject(error); }
      });
      next();
    });
    return replies.filter(message => message.id !== 0);
  } finally { clearTimeout(timer); lines.close(); if (child.exitCode === null) child.kill(); }
}
const status = (url, headers) => new Promise((resolve, reject) => {
  request(url, { headers }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
});
test('owner-backed observation, detail, pagination and CLI/MCP remain read-only', async t => {
  const f = fixture(t); await seed(f);
  const before = bytes(f.temporary);
  const snapshot = await readMailboard(f.core);
  assert.equal(snapshot.totals.retained, 2);
  assert.equal(snapshot.totals.readableOwners, 1);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.deliverySideEffects, false);
  const items = snapshot.modules[0].observation.items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].deliveryId, items[1].deliveryId);
  assert.equal(items[0].evidence.ownerAccepted, true);
  assert.notEqual(items[0].evidence.providerAccepted, true);
  assert.notEqual(items[0].evidence.consumerConfirmed, true);
  const args = { moduleId: 'agent-mail', view: 'detail', deliveryId: items[0].deliveryId };
  const detail = await readMailboard(f.core, args);
  assert.equal(detail.modules[0].observation.item.content.text, xss);
  assert.equal(detail.modules[0].observation.item.evidence.businessAccepted, 'unknown');
  await assert.rejects(readMailboard(f.core, { view: 'detail', deliveryId: items[0].deliveryId }));
  await assert.rejects(readMailboard(f.core, { view: 'items', operation: 'send' }));
  await assert.rejects(readMailboard(f.core, { view: 'items', limit: 101 }));
  const page = await readMailboard(f.core, { moduleId: 'agent-mail', view: 'items', limit: 1 });
  assert.ok(page.modules[0].observation.nextCursor);
  const next = await readMailboard(f.core, { moduleId: 'agent-mail', view: 'items', limit: 1, cursor: page.modules[0].observation.nextCursor });
  assert.notEqual(next.modules[0].observation.items[0].deliveryId, page.modules[0].observation.items[0].deliveryId);
  assert.equal(next.totals.retained, 2);
  const response = (await mcp(f, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_mailboard', arguments: args } }]))[0];
  assert.equal(response.result.structuredContent.modules[0].observation.item.content.text, xss);
  const readArgs = { moduleId: 'agent-mail', operation: 'message_observe', args: { view: 'detail', deliveryId: items[0].deliveryId } };
  const cli = spawnSync(process.execPath, [join(root, 'src', 'cli.mjs'), '--registry', f.registryPath, 'read'], {
    input: JSON.stringify(readArgs), env: f.env, encoding: 'utf8', timeout: 20_000, windowsHide: true
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliDetail = JSON.parse(cli.stdout).item;
  assert.deepEqual(cliDetail, response.result.structuredContent.modules[0].observation.item);
  assert.deepEqual(bytes(f.temporary), before, 'observation must not alter DB, WAL, reader confirmation or registry');
});
test('native UI metadata is opt-in, app-only, and serves a single inert HTML resource', async t => {
  const f = fixture(t);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: MAILBOARD_URI } },
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'file:///private' } },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: MAILBOARD_URI,
      _meta: { progressToken: 'read-ui', 'client/context': { uri: 'file:///private' } } } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: MAILBOARD_URI, extra: true } }
  ];
  const [tools, resource, invalid, withMetadata, extra] = await mcp(f, messages);
  assert.deepEqual(tools.result.tools.slice(0, 3).map(tool => tool.name), ['agent_discover', 'agent_read', 'agent_act']);
  const app = tools.result.tools[3];
  assert.deepEqual(app._meta.ui.visibility, ['app']);
  assert.equal(app._meta.ui.resourceUri, MAILBOARD_URI);
  assert.deepEqual(app._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.equal(app.annotations.readOnlyHint, true);
  const html = resource.result.contents[0].text;
  assert.ok(html.includes('textContent'));
  assert.ok(!html.includes('innerHTML'));
  assert.ok(!html.includes('<script src='));
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(invalid.error);
  assert.ok(withMetadata.result, withMetadata.error?.message);
  assert.deepEqual(withMetadata.result, resource.result, 'standard request metadata must not block or redirect the UI read');
  assert.equal(extra.error.code, -32602);
  assert.equal((await mcp(f, [messages[0]], '0'))[0].result.tools.length, 3);
  const legacy = await mcp(f, [messages[0], { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_mailboard', arguments: {} } }], '1', {});
  assert.equal(legacy[0].result.tools.length, 3, 'legacy hosts must retain exactly three model tools');
  assert.ok(legacy[1].error);
  assert.equal((await mcp(f, [messages[0]], '1', { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: 'text/html;profile=mcp-app' } } }))[0].result.tools.length, 3);
});
test('loopback website authenticates same-origin reads and exposes no write route', async t => {
  const f = fixture(t); await seed(f);
  const before = bytes(f.temporary);
  const { server, url } = await startDashboard(f.core);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const api = url + 'api/observe';
  assert.equal((await fetch(api)).status, 401);
  assert.equal((await fetch(api, { headers: { cookie: 'mailboard=' + 'é'.repeat(64) } })).status, 401);
  assert.equal((await fetch(api, { headers: { cookie, origin: 'https://evil.invalid' } })).status, 403);
  assert.equal(await status(api, { cookie, host: 'evil.invalid' }), 403);
  assert.equal(await status(api, { cookie, 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal((await fetch(api, { method: 'POST', headers: { cookie } })).status, 405);
  assert.equal((await fetch(url + 'api/send', { headers: { cookie } })).status, 404);
  assert.equal((await fetch(api + '?q={}&q={}', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(api + '?q=' + encodeURIComponent('{"operation":"confirm_and_fetch"}'), { headers: { cookie } })).status, 400);
  const observed = await fetch(api, { headers: { cookie, origin: new URL(url).origin } });
  assert.equal(observed.status, 200);
  assert.equal((await observed.json()).totals.retained, 2);
  assert.deepEqual(bytes(f.temporary), before);
});

test('multiple observation channels keep owner identity, selection and reads separate', async () => {
  const calls = [];
  let returnOwner = 'qoder-return-store:fixture';
  const core = {
    async agentDiscover({ moduleId } = {}) {
      if (!moduleId) return { modules: [{ id: 'agent-qoder', name: 'Qoder', enabled: true }] };
      return { operations: [
        { name: 'message_observe', annotations: { readOnlyHint: true } },
        { name: 'message_observe_return', annotations: { readOnlyHint: true, messageObservationHint: true } },
        { name: 'interrupt', annotations: { readOnlyHint: false, messageObservationHint: true } },
        { name: 'identity', annotations: { readOnlyHint: true } }
      ] };
    },
    async agentRead(input) {
      calls.push(input);
      assert.ok(['message_observe', 'message_observe_return'].includes(input.operation));
      const outbound = input.operation === 'message_observe';
      return { schemaVersion: 1, moduleId: 'agent-qoder',
        ownerId: outbound ? 'qoder-queue:fixture' : returnOwner,
        observedAt: '2026-10-02T02:00:00.000Z', scope: { kind: 'retained' },
        retention: { historicalContent: 'unknown' }, coverage: { complete: outbound || returnOwner !== 'unknown', limitations: [] },
        ...(input.args.view === 'stats' ? { stats: { total: outbound ? 2 : returnOwner === 'unknown' ? 'unknown' : 3, byState: { recorded: outbound ? 2 : 3 } } }
          : input.args.view === 'detail' ? { item: null } : { items: [], hasMore: false, nextCursor: null }) };
    }
  };
  const all = await readMailboard(core);
  assert.equal(all.modules.length, 2);
  assert.deepEqual(all.totals, { retained: 5, readableOwners: 2, complete: true });
  assert.deepEqual(all.modules.map(row => row.operation), ['message_observe', 'message_observe_return']);
  const legacy = await readMailboard(core, { moduleId: 'agent-qoder' });
  assert.equal(legacy.modules.length, 1); assert.equal(legacy.totals.retained, 2);
  const detail = await readMailboard(core, { moduleId: 'agent-qoder', operation: 'message_observe_return',
    view: 'detail', deliveryId: 'return-delivery' });
  assert.equal(detail.modules[0].statistics.ownerId, returnOwner);
  assert.equal(detail.modules[0].observation.item, null);
  const beforeRejected = calls.length;
  await assert.rejects(readMailboard(core, { moduleId: 'agent-qoder', operation: 'interrupt' }), /read-only message observer/);
  await assert.rejects(readMailboard(core, { moduleId: 'agent-qoder', operation: 'identity' }), /read-only message observer/);
  await assert.rejects(readMailboard(core, { operation: 'message_observe_return' }), /selected module/);
  assert.equal(calls.length, beforeRejected, 'a selected non-observer must never reach a module call');
  returnOwner = 'qoder-queue:fixture';
  assert.equal((await readMailboard(core)).totals.readableOwners, 1, 'aliases must not double-count a persistent owner');
  returnOwner = 'unknown';
  assert.deepEqual((await readMailboard(core, { moduleId: 'agent-qoder', operation: 'message_observe_return' })).totals,
    { retained: 0, readableOwners: 0, complete: false }, 'an unidentified store must not count as a real owner');
});
