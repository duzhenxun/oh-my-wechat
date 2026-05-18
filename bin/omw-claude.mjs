#!/usr/bin/env node

process.argv.push("--mode", "claude");
const mod = await import("../dist/bridge/run-bridge.js");
await mod.runBridgeCli();
