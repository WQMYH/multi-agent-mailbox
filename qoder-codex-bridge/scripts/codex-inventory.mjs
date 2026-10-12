import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Only metadata enumeration: never resume a thread, load turns, or invoke a model.
export function listStoredCodexThreads(executable, home, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ["-c", "features.code_mode_host=false", "app-server", "--listen", "stdio://"], {
      env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    const rows = [], cursors = new Set();
    let nextId = 1, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.close();
      child.kill();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      error ? reject(Object.assign(Error("Stored Codex inventory unavailable"), { code: "host_inventory_unavailable" })) : resolve(rows);
    };
    const timer = setTimeout(() => finish(true), 20_000);
    const input = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.on("error", () => finish(true));
    child.on("exit", () => finish(true));
    child.stdin.on("error", () => finish(true));
    const request = (method, params) => child.stdin.write(JSON.stringify({ id: nextId, method, params }) + "\n");
    const page = cursor => request("thread/list", {
      limit: 200, cursor, archived: false, useStateDbOnly: true, sortKey: "updated_at",
      // Omitted/null is provider-filtered on the installed CLI; [] actually includes all providers.
      modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]
    });
    input.on("line", line => {
      if (settled) return;
      try {
        if (line.length > 4 * 1024 * 1024) return finish(true);
        const message = JSON.parse(line);
        if (message.id !== nextId) return;
        if (message.error || !message.result) return finish(true);
        if (nextId++ === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          return page(null);
        }
        const result = message.result;
        if (!Array.isArray(result.data) || result.nextCursor !== null && typeof result.nextCursor !== "string") return finish(true);
        rows.push(...result.data);
        if (result.nextCursor === null) return finish();
        if (!result.nextCursor || cursors.has(result.nextCursor) || cursors.size >= 49) return finish(true);
        cursors.add(result.nextCursor);
        page(result.nextCursor);
      } catch { finish(true); }
    });
    request("initialize", { clientInfo: { name: "post-chat-inventory", version: "0.1.2" }, capabilities: {} });
  });
}
