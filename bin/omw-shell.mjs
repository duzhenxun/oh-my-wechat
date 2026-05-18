#!/usr/bin/env node

process.argv.push("--mode", "shell");
const mod = await import("../dist/bridge/run-bridge.js");
await mod.runBridgeCli();
