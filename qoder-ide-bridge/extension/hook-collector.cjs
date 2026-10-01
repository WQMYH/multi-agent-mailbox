"use strict";

const { readFileSync } = require("node:fs");
const { collectHook } = require("./message-store.cjs");

function collect(raw, configPath) { return collectHook(raw, configPath); }

if (require.main === module) {
  const result = collect(readFileSync(0, "utf8"), process.argv[2]);
  if (["unattributable", "ambiguous", "unsupported"].includes(result)) process.exitCode = 2;
}

module.exports = { collect };
