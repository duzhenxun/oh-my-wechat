#!/usr/bin/env node

process.argv.push("--mode", "codex");
const mod = await import("../dist/bridge/run-bridge.js");
await mod.runBridgeCli();
