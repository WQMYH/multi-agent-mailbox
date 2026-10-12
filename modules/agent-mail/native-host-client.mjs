import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Same native MCP primitive as the existing host bridge, without its Qoder notification policy.
export class NativeHostClient {
  constructor(config, { spawnProcess = spawn, timeoutMs = 15000 } = {}) {
    this.nextId = 1; this.pending = new Map(); this.timeoutMs = timeoutMs; this.threadId = config.threadId;
    this.child = spawnProcess(process.execPath, [config.script], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: config.pipePath },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail(); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error || message.result?.isError) pending.reject(Error('Native Codex host request failed'));
      else pending.resolve(message.result);
    });
    this.child.on('error', () => this.fail()); this.child.on('exit', () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Native Codex host disconnected')); }
    this.pending.clear();
  }
  write(value) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
  request(method, params) {
    if (this.closed) return Promise.reject(Error('Native Codex host disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Native Codex host timed out')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch { this.fail(); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'agent-mail-native-receiver', version: '0.2.0' } });
    if (result?.protocolVersion !== '2025-06-18') throw Error('Native Codex host protocol mismatch');
    this.write({ method: 'notifications/initialized', params: {} });
  }
  async call(name, args) {
    if (!['read_thread', 'send_message_to_thread'].includes(name)) throw Error('Native Codex host tool is not allowed');
    const result = await this.request('tools/call', { name, arguments: args, _meta: { codexThreadId: this.threadId } });
    try { return JSON.parse(result?.content?.find(content => content.type === 'text')?.text); }
    catch { throw Error('Native Codex host response is invalid'); }
  }
  close() {
    if (this.disposed) return this.closeResult;
    this.disposed = true; this.fail();
    let ok = true;
    try { this.lines.close(); this.child.stdin.end(); } catch { ok = false; }
    // Only the stdio helper constructed by this client is terminated, never a discovered product PID.
    try { if (!this.child.killed && this.child.exitCode == null && this.child.kill() === false) ok = false; }
    catch { ok = false; }
    return this.closeResult = { ok };
  }
}
