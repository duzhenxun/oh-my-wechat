import crypto from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadAccount } from "./login.js";
import { cleanupLegacyClaimsDir, CONTEXT_PATH, CURSOR_PATH, WIRE_VERSION, ensureOmwHome, readJson, writeJson, } from "./paths.js";
const MSG_USER = 1;
const MSG_BOT = 2;
const MSG_DONE = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const UPLOAD_IMAGE = 1;
const UPLOAD_VIDEO = 2;
const UPLOAD_FILE = 3;
const UPLOAD_VOICE = 4;
const CDN_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const PROJECT_OMW_DIR = ".oh-my-wechat";
const INCOMING_MEDIA_DIR = "incoming-media";
const CLAIM_CACHE_LIMIT = 2_000;
function normalizeBase(baseUrl) {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
function randomClientId() {
    return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}
function randomUin() {
    return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}
function formatOutgoingTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}年${month}月${day}日 ${hour}:${minute}:${second}`;
}
function headers(account, body) {
    return {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
        "X-WECHAT-UIN": randomUin(),
    };
}
function maskSecret(value) {
    if (value.length <= 8) {
        return "***";
    }
    return `${value.slice(0, 4)}***${value.slice(-4)}`;
}
function sanitizeForLog(value) {
    if (typeof value === "string") {
        return value.length > 5000 ? `${value.slice(0, 5000)}...<truncated>` : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForLog(item));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const secretKeys = new Set([
        "authorization",
        "token",
        "context_token",
        "aes_key",
        "aeskey",
        "upload_param",
        "x-encrypted-param",
        "encrypted_query_param",
    ]);
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
        if (secretKeys.has(key.toLowerCase())) {
            return [key, typeof nested === "string" ? maskSecret(nested) : "***"];
        }
        return [key, sanitizeForLog(nested)];
    }));
}
function formatLogPayload(value) {
    if (typeof value === "string") {
        try {
            return JSON.stringify(sanitizeForLog(JSON.parse(value)), null, 2);
        }
        catch {
            return String(sanitizeForLog(value));
        }
    }
    return JSON.stringify(sanitizeForLog(value), null, 2);
}
function writeHttpLog(context, title, payload) {
    if (!context?.enabled || !context.log) {
        return;
    }
    context.log([title, formatLogPayload(payload)].join("\n"));
}
async function postJson(account, endpoint, bodyValue, timeoutMs = 35_000, logContext) {
    const body = JSON.stringify(bodyValue);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(endpoint, normalizeBase(account.baseUrl));
    const requestHeaders = headers(account, body);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: requestHeaders,
            body,
            signal: controller.signal,
        });
        const text = await res.text();
        const responsePayload = {
            url: url.toString(),
            status: res.status,
            ok: res.ok,
            body: text,
        };
        const shouldLog = logContext?.shouldLog ? logContext.shouldLog(responsePayload) : true;
        if (shouldLog) {
            writeHttpLog(logContext, `[wechat http request] ${endpoint}`, {
                url: url.toString(),
                method: "POST",
                headers: requestHeaders,
                body: bodyValue,
            });
            writeHttpLog(logContext, `[wechat http response] ${endpoint}`, responsePayload);
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return text;
    }
    finally {
        clearTimeout(timer);
    }
}
function assertWechatOk(result, action) {
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
        throw new Error(`${action} failed: ret=${result.ret} errcode=${result.errcode} ${result.errmsg ?? ""}`.trim());
    }
}
function encodeMessageAesKey(aesKey) {
    return Buffer.from(aesKey.toString("hex")).toString("base64");
}
function decodeIncomingAesKey(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("Incoming media aes_key is empty.");
    }
    if (/^[0-9a-f]{32}$/i.test(trimmed)) {
        return Buffer.from(trimmed, "hex");
    }
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) {
        return decoded;
    }
    const asText = decoded.toString("utf8").trim();
    if (/^[0-9a-f]{32}$/i.test(asText)) {
        return Buffer.from(asText, "hex");
    }
    throw new Error("Incoming media aes_key is not a supported format.");
}
function extractInboundContent(raw) {
    const text = [];
    const attachments = [];
    for (const item of raw.item_list ?? []) {
        const refTitle = item.ref_msg?.title?.trim();
        const refText = item.ref_msg?.message_item?.text_item?.text?.trim();
        if (refTitle || refText) {
            text.push(`Quoted: ${[refTitle, refText].filter(Boolean).join(" | ")}`);
        }
        if (item.type === ITEM_TEXT && item.text_item?.text?.trim()) {
            text.push(item.text_item.text.trim());
            continue;
        }
        if (item.type === ITEM_VOICE) {
            if (item.voice_item?.text?.trim()) {
                text.push(item.voice_item.text.trim());
            }
            if (item.voice_item?.media) {
                attachments.push({
                    kind: "voice",
                    ...(item.voice_item.media.encrypt_query_param ? { downloadParam: item.voice_item.media.encrypt_query_param } : {}),
                    ...(item.voice_item.media.aes_key ? { aesKey: item.voice_item.media.aes_key } : {}),
                    ...(raw.create_time_ms ? { createdAtMs: raw.create_time_ms } : {}),
                });
            }
            continue;
        }
        if (item.type === ITEM_IMAGE && item.image_item?.media) {
            attachments.push({
                kind: "image",
                ...(item.image_item.media.encrypt_query_param ? { downloadParam: item.image_item.media.encrypt_query_param } : {}),
                ...(item.image_item.media.aes_key ? { aesKey: item.image_item.media.aes_key } : {}),
                ...(raw.create_time_ms ? { createdAtMs: raw.create_time_ms } : {}),
            });
            continue;
        }
        if (item.type === ITEM_VIDEO && item.video_item?.media) {
            attachments.push({
                kind: "video",
                ...(item.video_item.media.encrypt_query_param ? { downloadParam: item.video_item.media.encrypt_query_param } : {}),
                ...(item.video_item.media.aes_key ? { aesKey: item.video_item.media.aes_key } : {}),
                ...(raw.create_time_ms ? { createdAtMs: raw.create_time_ms } : {}),
            });
            continue;
        }
        if (item.type === ITEM_FILE && item.file_item?.media) {
            attachments.push({
                kind: "file",
                ...(item.file_item.file_name?.trim() ? { fileName: item.file_item.file_name.trim() } : {}),
                ...(item.file_item.media.encrypt_query_param ? { downloadParam: item.file_item.media.encrypt_query_param } : {}),
                ...(item.file_item.media.aes_key ? { aesKey: item.file_item.media.aes_key } : {}),
                ...(raw.create_time_ms ? { createdAtMs: raw.create_time_ms } : {}),
            });
        }
    }
    return {
        text: text.join("\n").trim(),
        attachments,
    };
}
function messageKey(account, raw) {
    return [
        account.botId,
        raw.from_user_id ?? "",
        raw.client_id ?? "",
        raw.create_time_ms ?? "",
        raw.context_token ?? "",
    ].join("|");
}
function trimClaimCache(claims) {
    while (claims.size > CLAIM_CACHE_LIMIT) {
        const oldest = claims.keys().next().value;
        if (!oldest) {
            return;
        }
        claims.delete(oldest);
    }
}
function claimMessage(claims, key) {
    if (claims.has(key)) {
        return false;
    }
    claims.set(key, Date.now());
    trimClaimCache(claims);
    return true;
}
function fileSizeLabel(bytes) {
    if (bytes > 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    if (bytes > 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
}
function sanitizeFileName(fileName) {
    const base = path.basename(fileName).replace(/[\x00-\x1F<>:"/\\|?*]+/g, "_").trim();
    return base || "attachment";
}
function defaultExtension(kind) {
    if (kind === "image") {
        return ".jpg";
    }
    if (kind === "video") {
        return ".mp4";
    }
    if (kind === "voice") {
        return ".m4a";
    }
    return ".bin";
}
function incomingDateDir(timestampMs) {
    return new Date(timestampMs).toISOString().slice(0, 10);
}
function detectFileExtension(kind, data) {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return ".png";
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return ".jpg";
    }
    if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) {
        return ".gif";
    }
    if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
        return ".webp";
    }
    if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM") {
        return ".bmp";
    }
    if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") {
        const brand = data.subarray(8, 12).toString("ascii").toLowerCase();
        if (brand.includes("qt")) {
            return ".mov";
        }
        if (kind === "voice") {
            return ".m4a";
        }
        return ".mp4";
    }
    if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "%PDF") {
        return ".pdf";
    }
    if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        return ".zip";
    }
    if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") {
        return ".wav";
    }
    if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "ID3") {
        return ".mp3";
    }
    return defaultExtension(kind);
}
export class WechatWire {
    cursor = "";
    contexts = new Map();
    claims = new Map();
    httpLogEnabled;
    log;
    workspaceCwd;
    constructor(log = () => undefined, workspaceCwd = process.cwd(), options = {}) {
        this.log = log;
        this.workspaceCwd = workspaceCwd;
        this.httpLogEnabled = options.httpLog === true;
        if (cleanupLegacyClaimsDir()) {
            this.log("Cleaned legacy message-claims cache.");
        }
        this.cursor = fs.existsSync(CURSOR_PATH) ? fs.readFileSync(CURSOR_PATH, "utf8") : "";
        this.contexts = new Map(Object.entries(readJson(CONTEXT_PATH) ?? {}));
    }
    account() {
        const account = loadAccount();
        if (!account) {
            throw new Error("No WeChat login found. Run omw-setup first.");
        }
        return account;
    }
    statusText() {
        const account = loadAccount();
        return [
            `home: ${path.dirname(CONTEXT_PATH)}`,
            `account: ${account ? account.botId : "(none)"}`,
            `user: ${account?.userId ?? "(none)"}`,
            `contexts: ${this.contexts.size}`,
            `cursor: ${this.cursor ? "present" : "empty"}`,
            `incoming_media_dir: ${this.incomingMediaDir()}`,
            `incoming_image_dir: ${this.incomingMediaDir("image")}`,
            `incoming_voice_dir: ${this.incomingMediaDir("voice")}`,
            `incoming_video_dir: ${this.incomingMediaDir("video")}`,
            `incoming_file_dir: ${this.incomingMediaDir("file")}`,
        ].join("\n");
    }
    async poll(timeoutMs = 35_000, minCreatedAtMs) {
        const account = this.account();
        const parsed = JSON.parse(await postJson(account, "ilink/bot/getupdates", {
            get_updates_buf: this.cursor,
            base_info: { channel_version: WIRE_VERSION },
        }, timeoutMs, this.updatesHttpLogContext()));
        if (parsed.errcode === -14 && /session timeout/i.test(parsed.errmsg ?? "")) {
            this.cursor = "";
            fs.rmSync(CURSOR_PATH, { force: true });
            throw new Error("WeChat session timed out. Run omw-setup --force.");
        }
        if ((parsed.ret ?? 0) !== 0 || (parsed.errcode ?? 0) !== 0) {
            throw new Error(`getupdates failed: ret=${parsed.ret} errcode=${parsed.errcode} ${parsed.errmsg ?? ""}`);
        }
        if (parsed.get_updates_buf) {
            this.cursor = parsed.get_updates_buf;
            ensureOmwHome();
            fs.writeFileSync(CURSOR_PATH, this.cursor, "utf8");
        }
        const messages = [];
        let ignored = 0;
        for (const raw of parsed.msgs ?? []) {
            if (raw.message_type !== MSG_USER) {
                continue;
            }
            const content = extractInboundContent(raw);
            if (!content.text && content.attachments.length === 0) {
                continue;
            }
            if (!claimMessage(this.claims, messageKey(account, raw))) {
                continue;
            }
            if (raw.context_token && raw.from_user_id) {
                this.contexts.set(raw.from_user_id, raw.context_token);
                writeJson(CONTEXT_PATH, Object.fromEntries(this.contexts));
            }
            if (minCreatedAtMs && (!raw.create_time_ms || raw.create_time_ms < minCreatedAtMs)) {
                ignored += 1;
                continue;
            }
            const senderId = raw.from_user_id ?? "unknown";
            const attachments = await this.materializeAttachments(content.attachments);
            messages.push({
                senderId,
                senderName: senderId.split("@")[0] || senderId,
                text: content.text,
                attachments,
                sessionId: raw.session_id ?? "",
                ...(raw.context_token ? { contextToken: raw.context_token } : {}),
                createdAt: new Date(raw.create_time_ms ?? Date.now()).toISOString(),
                ...(raw.create_time_ms ? { createdAtMs: raw.create_time_ms } : {}),
            });
        }
        return { messages, ignored };
    }
    async sendText(text, recipientId) {
        const { account, to, token } = this.resolveRecipient(recipientId);
        const trimmed = text.trim();
        if (!trimmed) {
            return to;
        }
        const stamped = `${formatOutgoingTimestamp()}\n${trimmed}`;
        await this.sendItems(account, to, token, [{ type: ITEM_TEXT, text_item: { text: stamped } }]);
        return to;
    }
    async sendFile(filePath, recipientId, label = "file") {
        const { account, to, token } = this.resolveRecipient(recipientId);
        const upload = await this.upload(account, to, filePath, label);
        const media = {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aesKey),
            encrypt_type: 1,
        };
        const item = label === "image"
            ? { type: ITEM_IMAGE, image_item: { media, mid_size: upload.encryptedSize } }
            : label === "voice"
                ? { type: ITEM_VOICE, voice_item: { media } }
                : label === "video"
                    ? { type: ITEM_VIDEO, video_item: { media, video_size: upload.encryptedSize } }
                    : { type: ITEM_FILE, file_item: { file_name: path.basename(filePath), len: String(upload.rawSize), media } };
        await this.sendItems(account, to, token, [item]);
        return to;
    }
    resolveRecipient(recipientId) {
        const account = this.account();
        const to = recipientId || [...this.contexts.keys()].at(-1);
        if (!to) {
            throw new Error("No recent WeChat sender is known yet.");
        }
        const token = this.contexts.get(to);
        if (!token) {
            throw new Error(`No reply context for ${to}. Ask that user to send another message.`);
        }
        return { account, to, token };
    }
    incomingMediaDir(kind) {
        const root = path.join(this.workspaceCwd, PROJECT_OMW_DIR, INCOMING_MEDIA_DIR);
        return kind ? path.join(root, kind) : root;
    }
    httpLogContext() {
        return {
            log: this.log,
            enabled: this.httpLogEnabled,
        };
    }
    updatesHttpLogContext() {
        return {
            ...this.httpLogContext(),
            shouldLog: (payload) => {
                const body = typeof payload === "object" && payload && "body" in payload ? payload.body : undefined;
                if (typeof body !== "string") {
                    return true;
                }
                try {
                    const parsed = JSON.parse(body);
                    return (parsed.msgs?.length ?? 0) > 0;
                }
                catch {
                    return true;
                }
            },
        };
    }
    logHttp(title, payload) {
        writeHttpLog(this.httpLogContext(), title, payload);
    }
    async materializeAttachments(attachments) {
        const output = [];
        for (const attachment of attachments) {
            if (attachment.kind === "voice" || !attachment.downloadParam || !attachment.aesKey) {
                output.push(attachment);
                continue;
            }
            try {
                output.push({
                    ...attachment,
                    localPath: await this.downloadIncomingAttachment(attachment),
                });
            }
            catch (error) {
                this.log(`Failed to download incoming ${attachment.kind}: ${error instanceof Error ? error.message : String(error)}`);
                output.push(attachment);
            }
        }
        return output;
    }
    async downloadIncomingAttachment(attachment) {
        if (!attachment.downloadParam || !attachment.aesKey) {
            throw new Error("Attachment is missing download parameters.");
        }
        const key = decodeIncomingAesKey(attachment.aesKey);
        const url = `${CDN_URL}/download?encrypted_query_param=${encodeURIComponent(attachment.downloadParam)}`;
        this.logHttp("[wechat cdn request] download", {
            url,
            method: "GET",
            attachment,
        });
        const res = await fetch(url);
        this.logHttp("[wechat cdn response] download", {
            url,
            status: res.status,
            ok: res.ok,
        });
        if (!res.ok) {
            throw new Error(`CDN download failed: HTTP ${res.status}`);
        }
        const encrypted = Buffer.from(await res.arrayBuffer());
        const decipher = createDecipheriv("aes-128-ecb", key, null);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const filePath = this.buildIncomingAttachmentPath(attachment, decrypted);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, decrypted);
        this.log(`Downloaded incoming ${attachment.kind}: ${filePath} (${fileSizeLabel(decrypted.length)})`);
        return filePath;
    }
    buildIncomingAttachmentPath(attachment, data) {
        const ext = attachment.fileName
            ? path.extname(sanitizeFileName(attachment.fileName)) || detectFileExtension(attachment.kind, data)
            : detectFileExtension(attachment.kind, data);
        const base = attachment.fileName
            ? path.basename(sanitizeFileName(attachment.fileName), path.extname(sanitizeFileName(attachment.fileName)))
            : attachment.kind;
        const timestamp = attachment.createdAtMs ?? Date.now();
        const hash = crypto.createHash("sha1").update(data.subarray(0, Math.min(data.length, 1024))).digest("hex").slice(0, 10);
        const dateDir = incomingDateDir(timestamp);
        return path.join(this.incomingMediaDir(attachment.kind), dateDir, `${timestamp}-${base}-${hash}${ext || defaultExtension(attachment.kind)}`);
    }
    async sendItems(account, to, contextToken, itemList) {
        const result = JSON.parse(await postJson(account, "ilink/bot/sendmessage", {
            msg: {
                from_user_id: "",
                to_user_id: to,
                client_id: randomClientId(),
                message_type: MSG_BOT,
                message_state: MSG_DONE,
                item_list: itemList,
                context_token: contextToken,
            },
            base_info: { channel_version: WIRE_VERSION },
        }, 15_000, this.httpLogContext()));
        assertWechatOk(result, "sendmessage");
    }
    async upload(account, to, filePath, label) {
        const data = fs.readFileSync(filePath);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            throw new Error(`${filePath} is not a file.`);
        }
        const maxMb = Number(process.env.OH_MY_WECHAT_MAX_UPLOAD_MB || (label === "video" ? 100 : label === "file" ? 50 : 20));
        if (data.length > maxMb * 1024 * 1024) {
            throw new Error(`${label} is too large: ${fileSizeLabel(data.length)} exceeds ${maxMb} MB.`);
        }
        const aesKey = crypto.randomBytes(16);
        const filekey = crypto.randomBytes(16).toString("hex");
        const encryptedSize = Math.ceil((data.length + 1) / 16) * 16;
        const media_type = label === "image" ? UPLOAD_IMAGE : label === "video" ? UPLOAD_VIDEO : label === "voice" ? UPLOAD_VOICE : UPLOAD_FILE;
        this.log(`Uploading ${label}: ${filePath} (${fileSizeLabel(data.length)})`);
        const uploadInfo = JSON.parse(await postJson(account, "ilink/bot/getuploadurl", {
            filekey,
            media_type,
            to_user_id: to,
            rawsize: data.length,
            rawfilemd5: crypto.createHash("md5").update(data).digest("hex"),
            filesize: encryptedSize,
            aeskey: aesKey.toString("hex"),
            no_need_thumb: true,
            base_info: { channel_version: WIRE_VERSION },
        }, 15_000, this.httpLogContext()));
        assertWechatOk(uploadInfo, "getuploadurl");
        if (!uploadInfo.upload_param) {
            throw new Error("WeChat upload URL response did not include upload_param.");
        }
        const cipher = createCipheriv("aes-128-ecb", aesKey, null);
        const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        const url = `${CDN_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadInfo.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
        this.logHttp("[wechat cdn request] upload", {
            url,
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            filePath,
            rawSize: data.length,
            encryptedSize,
        });
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Uint8Array(encrypted),
        });
        const responseText = res.status === 200 ? "" : await res.text();
        this.logHttp("[wechat cdn response] upload", {
            url,
            status: res.status,
            ok: res.ok,
            headers: {
                "x-encrypted-param": res.headers.get("x-encrypted-param"),
            },
            body: responseText,
        });
        if (res.status !== 200) {
            throw new Error(`CDN upload failed: HTTP ${res.status} ${responseText}`);
        }
        const downloadParam = res.headers.get("x-encrypted-param");
        if (!downloadParam) {
            throw new Error("CDN upload response missed x-encrypted-param.");
        }
        return { rawSize: data.length, encryptedSize, aesKey, downloadParam };
    }
}
//# sourceMappingURL=wire.js.map