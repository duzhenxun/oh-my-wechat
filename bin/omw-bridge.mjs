#!/usr/bin/env node

const mod = await import("../dist/bridge/run-bridge.js");
await mod.runBridgeCli();
