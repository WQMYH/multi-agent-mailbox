# Qoder CN IDE command and page bridge

`extension/` is a dependency-free VS Code extension for Qoder CN IDE. `package-vsix.ps1` builds a normal VSIX under `dist/`; it does not install it.

Run the offline bridge/module test from the repository root:

```powershell
node qoder-ide-bridge/test/bridge.test.mjs
node qoder-ide-bridge/test/claim-budget.test.mjs
```

The bridge provides explicit conversation activation, serialized current-page sends, and non-consuming status/reply reads backed by matching project Hooks. Its single reservation-store lock covers claims, message admission and Hook persistence; admission retains the bounded update and atomic-replacement capacity before dispatch. A timed-out native promise keeps that instance's mutating lane isolated until real settlement. The bridge still cannot query or lock the current page, so it does not claim atomic session delivery. Authenticated commands, page sends/replies and a real pre-send page switch were tested in isolated windows; see [tested scope](../docs/compatibility.md).

Optional installation sequence:

1. Create the shared config from `modules/agent-qoder-ide/config.example.json`, replace the sentinel token with random data, and restrict the file to the current user.
2. Build and install `dist/qoder-ide-command-bridge-0.2.0.vsix` with the matching installation's CLI script, for example `& 'D:\Program Files\Qoder CN IDE\bin\code.cmd' --install-extension '<absolute-vsix-path>' --force`. On the verified Windows 1.31.1 installation, this script runs the adjacent IDE executable with its bundled CLI. A successful install does not mean an already-open window has reloaded the extension; verify its identity separately. Do not close or reload user windows.
3. Copy/package `modules/agent-qoder-ide` as one module root and register that exact root with the accepted Agent Core CLI. Point Core and the VSIX at the same config path.
4. For page-send observation, merge `UserPromptSubmit` and `Stop` command Hooks into the target workspace's `.qoder/settings.local.json`; point both at the packaged `extension/hook-collector.cjs` and the same absolute bridge config path. Preserve existing settings. Hook configuration is a separate root-owned runtime change.
5. Verify `instances`, then authenticated `identity`, before one explicitly authorized action. Record VSIX installation, live bridge identity, durable reservation, provider input Hook, correlated reply Hook and business acceptance as separate gates.

Building a VSIX performs none of these installation or runtime configuration steps.
