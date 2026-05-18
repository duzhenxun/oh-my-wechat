#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function main(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) {
    console.log(`${pkg.name} is not published to npm yet. Local version: ${pkg.version}`);
    return;
  }
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status}`);
  }
  const latest = (await res.json()) as { version?: string };
  console.log(`local: ${pkg.version}`);
  console.log(`latest: ${latest.version ?? "(unknown)"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
