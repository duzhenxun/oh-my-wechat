#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import qrcode from "qrcode-terminal";
import { ACCOUNT_PATH, CONTEXT_PATH, CURSOR_PATH, ILINK_BASE_URL, ILINK_BOT_TYPE, WIRE_VERSION, ensureOmwHome, readJson, writeJson, } from "./paths.js";
function normalizeBaseUrl(value) {
    return value.endsWith("/") ? value : `${value}/`;
}
function randomUinHeader() {
    return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}
function resolveQrOptions(mode) {
    if (mode === "small") {
        return { small: true };
    }
    if (mode === "large") {
        return {};
    }
    return process.platform === "win32" ? {} : { small: true };
}
export function loadAccount() {
    return readJson(ACCOUNT_PATH);
}
export function saveAccount(account) {
    writeJson(ACCOUNT_PATH, account);
    for (const filePath of [CURSOR_PATH, CONTEXT_PATH]) {
        fs.rmSync(filePath, { force: true });
    }
    try {
        fs.chmodSync(ACCOUNT_PATH, 0o600);
    }
    catch {
        // Windows and some shared filesystems may not support chmod.
    }
}
export async function validateAccount(account, timeoutMs = 5_000) {
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
        const parsed = JSON.parse(text);
        if (parsed.errcode === -14 && /session timeout/i.test(parsed.errmsg ?? "")) {
            return "saved WeChat session expired";
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchLoginQr(baseUrl) {
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`, normalizeBaseUrl(baseUrl));
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`QR request failed with HTTP ${res.status}`);
    }
    return (await res.json());
}
async function readQrState(baseUrl, qrcodeId) {
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
        return (await res.json());
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return { status: "wait" };
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function ensureLogin(options = {}) {
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
    const qrOptions = resolveQrOptions(options.qrRenderMode);
    log("Scan this QR code in WeChat to authorize oh-my-wechat:");
    qrcode.generate(qr.qrcode_img_content || qr.qrcode, qrOptions, (text) => log(`${text}\n`));
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
            const account = {
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
function parseQrRenderMode(argv) {
    if (argv.includes("--qr-small")) {
        return "small";
    }
    if (argv.includes("--qr-large")) {
        return "large";
    }
    return undefined;
}
export async function runLoginCli() {
    const qrRenderMode = parseQrRenderMode(process.argv);
    await ensureLogin({
        force: process.argv.includes("--force"),
        ...(qrRenderMode ? { qrRenderMode } : {}),
    });
}
if (import.meta.url === `file://${process.argv[1]}`) {
    runLoginCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
//# sourceMappingURL=login.js.map