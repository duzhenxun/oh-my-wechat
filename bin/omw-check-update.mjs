#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcEntry = path.resolve(here, "../src/cli/check-update.ts");

if (existsSync(srcEntry)) {
  const result = spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    srcEntry,
    ...process.argv.slice(2),
  ], {
    stdio: "inherit",
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 0);
}

await import("../dist/cli/check-update.js");
