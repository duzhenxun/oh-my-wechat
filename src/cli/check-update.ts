#!/usr/bin/env node

import {
  compareVersions,
  fetchLatestVersion,
  readLocalPackageInfo,
} from "./version.js";

function usage(pkgName: string, version: string): string {
  return [
    `${pkgName} v${version}`,
    "",
    "Usage:",
    "  omw check-update",
    "",
    "Output:",
    "  name      包名",
    "  local     当前本地版本",
    "  latest    npm 上最新版本",
    "  status    up to date / update available / latest unknown / not published",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const pkg = readLocalPackageInfo();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage(pkg.name, pkg.version));
    return;
  }

  const latestResult = await fetchLatestVersion(pkg.name, { timeoutMs: 3_000 });

  console.log(`name: ${pkg.name}`);
  console.log(`local: ${pkg.version}`);

  if (latestResult.status === "ok") {
    console.log(`latest: ${latestResult.latestVersion}`);
    const comparison = compareVersions(pkg.version, latestResult.latestVersion);
    if (comparison === -1) {
      console.log("status: update available");
      console.log(`upgrade: npm i -g ${pkg.name}@latest`);
      return;
    }
    if (comparison === 0 || comparison === 1) {
      console.log("status: up to date");
      return;
    }
    console.log("status: latest unknown");
    return;
  }

  if (latestResult.status === "not_published") {
    console.log("latest: (not published)");
    console.log("status: not published");
    return;
  }

  console.log("latest: (unavailable)");
  console.log("status: latest unknown");
  console.error(latestResult.errorMessage);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
