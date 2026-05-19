import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
export function packageRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}
export function readLocalPackageInfo() {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
}
export async function fetchLatestVersion(name, options = {}) {
    const timeoutMs = options.timeoutMs ?? 1_500;
    try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) {
            return { status: "not_published" };
        }
        if (!res.ok) {
            return { status: "error", errorMessage: `npm registry returned HTTP ${res.status}` };
        }
        const latest = (await res.json());
        if (!latest.version) {
            return { status: "error", errorMessage: "npm registry did not return a version" };
        }
        return { status: "ok", latestVersion: latest.version };
    }
    catch (error) {
        return {
            status: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
        };
    }
}
export function compareVersions(local, latest) {
    const localParsed = parseVersion(local);
    const latestParsed = parseVersion(latest);
    if (!localParsed || !latestParsed) {
        return null;
    }
    if (localParsed.major !== latestParsed.major) {
        return localParsed.major < latestParsed.major ? -1 : 1;
    }
    if (localParsed.minor !== latestParsed.minor) {
        return localParsed.minor < latestParsed.minor ? -1 : 1;
    }
    if (localParsed.patch !== latestParsed.patch) {
        return localParsed.patch < latestParsed.patch ? -1 : 1;
    }
    if (localParsed.prerelease.length === 0 && latestParsed.prerelease.length === 0) {
        return 0;
    }
    if (localParsed.prerelease.length === 0) {
        return 1;
    }
    if (latestParsed.prerelease.length === 0) {
        return -1;
    }
    const maxLength = Math.max(localParsed.prerelease.length, latestParsed.prerelease.length);
    for (let index = 0; index < maxLength; index += 1) {
        const left = localParsed.prerelease[index];
        const right = latestParsed.prerelease[index];
        if (left == null) {
            return -1;
        }
        if (right == null) {
            return 1;
        }
        if (left === right) {
            continue;
        }
        if (typeof left === "number" && typeof right === "number") {
            return left < right ? -1 : 1;
        }
        if (typeof left === "number") {
            return -1;
        }
        if (typeof right === "number") {
            return 1;
        }
        return left < right ? -1 : 1;
    }
    return 0;
}
export function buildUpgradeHint(name, local, latest) {
    const comparison = compareVersions(local, latest);
    if (comparison !== -1) {
        return null;
    }
    return `Update available: ${local} -> ${latest}. Run: npm i -g ${name}@latest`;
}
function parseVersion(version) {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) {
        return null;
    }
    const prerelease = match[4]
        ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
        : [];
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease,
    };
}
//# sourceMappingURL=version.js.map