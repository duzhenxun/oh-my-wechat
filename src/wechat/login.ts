#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

import qrcode from "qrcode-terminal";

import {
  ACCOUNT_PATH,
  CONTEXT_PATH,
  CURSOR_PATH,
  ILINK_BASE_URL,
  ILINK_BOT_TYPE,
  WIRE_VERSION,
  ensureOmwHome,
  readJson,
  writeJson,
} from "./paths.js";

type QrPayload = {
  qrcode: string;
  qrcode_img_content?: string;
};

type QrState = {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
};

export type OmwAccount = {
  token: string;
  baseUrl: string;
  botId: string;
  userId?: string;
  savedAt: string;
};

export type LoginOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  pollEveryMs?: number;
  force?: boolean;
  log?: (line: string) => void;
};

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function randomUinHeader(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}

export function loadAccount(): OmwAccount | null {
  return readJson<OmwAccount>(ACCOUNT_PATH);
}

export function saveAccount(account: OmwAccount): void {
  writeJson(ACCOUNT_PATH, account);
  for (const filePath of [CURSOR_PATH, CONTEXT_PATH]) {
    fs.rmSync(filePath, { force: true });
  }
  try {
    fs.chmodSync(ACCOUNT_PATH, 0o600);
  } catch {
    // Windows and some shared filesystems may not support chmod.
  }
}

export async function validateAccount(
  account: OmwAccount,
  timeoutMs = 5_000,
): Promise<string | null> {
  const body = JSON.stringify({
    get_updates_buf: "",
    base_info: { channel_version: WIRE_VERSION },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(new URL("ilink/bot/getupdates", normalizeBaseUrl(account.baseUrl)), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
        "X-WECHAT-UIN": randomUinHeader(),
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return "saved credentials were rejected";
    }
    if (!res.ok) {
      return null;
    }
    const parsed = JSON.parse(text) as { errcode?: number; errmsg?: string };
    if (parsed.errcode === -14 && /session timeout/i.test(parsed.errmsg ?? "")) {
      return "saved WeChat session expired";
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoginQr(baseUrl: string): Promise<QrPayload> {
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`, normalizeBaseUrl(baseUrl));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`QR request failed with HTTP ${res.status}`);
  }
  return (await res.json()) as QrPayload;
}

async function readQrState(baseUrl: string, qrcodeId: string): Promise<QrState> {
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, normalizeBaseUrl(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`QR status failed with HTTP ${res.status}`);
    }
    return (await res.json()) as QrState;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureLogin(options: LoginOptions = {}): Promise<OmwAccount> {
  const log = options.log ?? ((line) => console.log(line));
  ensureOmwHome();

  if (!options.force) {
    const existing = loadAccount();
    if (existing) {
      const invalid = await validateAccount(existing);
      if (!invalid) {
        return existing;
      }
      log(`Saved login cannot be reused: ${invalid}.`);
    }
  }

  const baseUrl = options.baseUrl ?? ILINK_BASE_URL;
  const qr = await fetchLoginQr(baseUrl);
  log("Scan this QR code in WeChat to authorize oh-my-wechat:");
  qrcode.generate(qr.qrcode_img_content || qr.qrcode, { small: true }, (text: string) => log(`${text}\n`));

  const deadline = Date.now() + (options.timeoutMs ?? 3 * 60_000);
  const pollEveryMs = options.pollEveryMs ?? 1_500;

  while (Date.now() < deadline) {
    const state = await readQrState(baseUrl, qr.qrcode);
    if (state.status === "scaned") {
      log("QR scanned, waiting for confirmation...");
    }
    if (state.status === "expired") {
      throw new Error("WeChat login QR code expired. Run omw-setup again.");
    }
    if (state.status === "confirmed") {
      if (!state.bot_token || !state.ilink_bot_id) {
        throw new Error("WeChat confirmed login but did not return bot credentials.");
      }
      const account: OmwAccount = {
        token: state.bot_token,
        baseUrl: state.baseurl || baseUrl,
        botId: state.ilink_bot_id,
        ...(state.ilink_user_id ? { userId: state.ilink_user_id } : {}),
        savedAt: new Date().toISOString(),
      };
      saveAccount(account);
      log(`Login saved to ${ACCOUNT_PATH}`);
      return account;
    }
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }

  throw new Error("Timed out waiting for WeChat login confirmation.");
}

export async function runLoginCli(): Promise<void> {
  await ensureLogin({ force: process.argv.includes("--force") });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoginCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
