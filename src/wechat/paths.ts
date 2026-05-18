import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const ILINK_BASE_URL =
  process.env.OH_MY_WECHAT_ILINK_BASE_URL?.trim() ||
  "https://ilinkai.weixin.qq.com";

export const ILINK_BOT_TYPE = process.env.OH_MY_WECHAT_BOT_TYPE?.trim() || "3";
export const WIRE_VERSION = "0.3.0";

export const OMW_HOME = process.env.OH_MY_WECHAT_HOME?.trim()
  ? path.resolve(process.env.OH_MY_WECHAT_HOME.trim())
  : path.join(os.homedir(), ".oh-my-wechat");

export const ACCOUNT_PATH = path.join(OMW_HOME, "account.json");
export const CURSOR_PATH = path.join(OMW_HOME, "sync-cursor.txt");
export const CONTEXT_PATH = path.join(OMW_HOME, "reply-contexts.json");
export const BRIDGE_LOCK_PATH = path.join(OMW_HOME, "active-bridge-lock.json");
export const CODEX_RUNTIME_DIR = path.join(OMW_HOME, "codex-runtime");
const LEGACY_CLAIMS_DIR = path.join(OMW_HOME, "message-claims");

export type CodexRuntimeEndpoint = {
  cwd: string;
  command: string;
  url: string;
  tokenEnv: string;
  token: string;
  bridgePid: number;
  serverPid?: number;
  startedAt: string;
};

export type BridgeLock = {
  pid: number;
  mode: string;
  cwd: string;
  startedAt: string;
};

export function ensureOmwHome(): void {
  fs.mkdirSync(OMW_HOME, { recursive: true });
}

export function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  ensureOmwHome();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function cleanupLegacyClaimsDir(): boolean {
  try {
    if (!fs.existsSync(LEGACY_CLAIMS_DIR)) {
      return false;
    }
    fs.rmSync(LEGACY_CLAIMS_DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function codexRuntimePath(cwd: string): string {
  const key = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex");
  return path.join(CODEX_RUNTIME_DIR, `${key}.json`);
}

export function writeCodexRuntimeEndpoint(endpoint: CodexRuntimeEndpoint): void {
  ensureOmwHome();
  fs.mkdirSync(CODEX_RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(codexRuntimePath(endpoint.cwd), JSON.stringify(endpoint, null, 2), "utf8");
}

export function readCodexRuntimeEndpoint(cwd: string): CodexRuntimeEndpoint | null {
  return readJson<CodexRuntimeEndpoint>(codexRuntimePath(cwd));
}

export function clearCodexRuntimeEndpoint(cwd: string): void {
  fs.rmSync(codexRuntimePath(cwd), { force: true });
}

export function clearCodexRuntimeEndpointForPid(pid: number): void {
  if (!fs.existsSync(CODEX_RUNTIME_DIR)) {
    return;
  }
  for (const name of fs.readdirSync(CODEX_RUNTIME_DIR)) {
    const filePath = path.join(CODEX_RUNTIME_DIR, name);
    const endpoint = readJson<CodexRuntimeEndpoint>(filePath);
    if (endpoint?.bridgePid === pid) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

export function readActiveCodexRuntimeEndpoint(cwd: string): CodexRuntimeEndpoint | null {
  const endpoint = readCodexRuntimeEndpoint(cwd);
  if (!endpoint) {
    return null;
  }
  if (!isProcessAlive(endpoint.bridgePid)) {
    clearCodexRuntimeEndpoint(cwd);
    return null;
  }
  if (typeof endpoint.serverPid === "number" && !isProcessAlive(endpoint.serverPid)) {
    clearCodexRuntimeEndpoint(cwd);
    return null;
  }
  return endpoint;
}

export function readBridgeLock(): BridgeLock | null {
  return readJson<BridgeLock>(BRIDGE_LOCK_PATH);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killBridgeProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

export function listOtherBridgePids(currentPid: number): number[] {
  try {
    const output = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
    const markers = [
      "dist/bridge/run-bridge.js",
      "bin/omw-bridge.mjs",
      "bin/omw-codex.mjs",
      "bin/omw-claude.mjs",
      "bin/omw-opencode.mjs",
      "bin/omw-shell.mjs",
    ];
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) {
          return null;
        }
        const pid = Number(match[1]);
        const command = match[2] ?? "";
        if (!Number.isFinite(pid) || pid === currentPid) {
          return null;
        }
        if (!markers.some((marker) => command.includes(marker))) {
          return null;
        }
        return pid;
      })
      .filter((pid): pid is number => typeof pid === "number");
  } catch {
    return [];
  }
}

export async function killOtherBridges(currentPid: number, waitMs = 4_000): Promise<void> {
  const pids = [...new Set(listOtherBridgePids(currentPid))];
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    killBridgeProcess(pid);
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const alive = pids.filter((pid) => isProcessAlive(pid));
  if (alive.length > 0) {
    throw new Error(`Could not stop existing bridge process(es): ${alive.join(", ")}`);
  }
}

export async function acquireBridgeLock(lock: BridgeLock, options?: { replaceExisting?: boolean; waitMs?: number }): Promise<void> {
  ensureOmwHome();
  const replaceExisting = options?.replaceExisting === true;
  const waitMs = options?.waitMs ?? 4_000;

  for (;;) {
    try {
      fs.writeFileSync(BRIDGE_LOCK_PATH, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
      return;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "EEXIST") {
        throw error;
      }

      const existing = readBridgeLock();
      if (!existing) {
        fs.rmSync(BRIDGE_LOCK_PATH, { force: true });
        continue;
      }
      if (!isProcessAlive(existing.pid)) {
        fs.rmSync(BRIDGE_LOCK_PATH, { force: true });
        continue;
      }
      if (!replaceExisting) {
        throw new Error(
          `Another bridge is already running (pid ${existing.pid}, mode=${existing.mode}, cwd=${existing.cwd}). Stop it before starting a new one.`,
        );
      }

      killBridgeProcess(existing.pid);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(existing.pid)) {
          fs.rmSync(BRIDGE_LOCK_PATH, { force: true });
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Could not stop existing bridge (pid ${existing.pid}, mode=${existing.mode}, cwd=${existing.cwd}).`,
        );
      }
      fs.rmSync(BRIDGE_LOCK_PATH, { force: true });
    }
  }
}

export function releaseBridgeLock(pid: number): void {
  const existing = readBridgeLock();
  if (!existing || existing.pid !== pid) {
    return;
  }
  fs.rmSync(BRIDGE_LOCK_PATH, { force: true });
  clearCodexRuntimeEndpointForPid(pid);
}
