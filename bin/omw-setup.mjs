#!/usr/bin/env node

const mod = await import("../dist/wechat/login.js");
await mod.runLoginCli();
