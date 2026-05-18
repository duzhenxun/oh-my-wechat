import fs from "node:fs";
import path from "node:path";
export function now() {
    return new Date().toISOString();
}
export function cleanTerminalText(value) {
    return value
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
}
export function preview(value, limit = 240) {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}
export function humanStatus(lines) {
    return lines.filter(Boolean).join("\n");
}
export function defaultCommand(mode) {
    if (mode === "claude") {
        return "claude";
    }
    if (mode === "opencode") {
        return "opencode";
    }
    if (mode === "shell") {
        return process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
    }
    return "codex";
}
export function splitCommand(command) {
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const [file, ...args] = parts.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
    if (!file) {
        throw new Error("Command cannot be empty.");
    }
    return { file, args };
}
function describeWechatAttachment(attachment) {
    const label = attachment.kind === "image"
        ? "Image"
        : attachment.kind === "video"
            ? "Video"
            : attachment.kind === "voice"
                ? "Voice"
                : "File";
    return attachment.fileName ? `${label}: ${attachment.fileName}` : label;
}
function incomingAttachmentMarker(attachment) {
    if (!attachment.localPath) {
        return null;
    }
    const kind = classifyAttachment(attachment.localPath);
    return `[[${kind}:${attachment.localPath}]]`;
}
function wantsDirectWechatAttachment(text) {
    return /(发我|传我|回传|发给我|给我发|发过来|传过来|通过网桥|发到微信|传到微信|send me|send back|send to wechat|upload to wechat)/i.test(text);
}
export function promptForWechat(text, _cwd, attachments = []) {
    const lines = [];
    const trimmed = text.trim();
    if (trimmed) {
        lines.push(trimmed);
    }
    if (wantsDirectWechatAttachment(trimmed)) {
        lines.push([
            "If the user asks you to send a local image, video, file, or audio back to WeChat and you know its absolute path, output only the exact attachment marker for that path.",
            "oh-my-wechat will upload and send it automatically.",
            "Do not say you cannot send it directly.",
            "Do not tell the user to manually choose the file in WeChat.",
            "Do not explain steps, limits, or repeat the path outside the marker.",
        ].join(" "));
    }
    if (attachments.length > 0) {
        lines.push([
            "WeChat attachments are included below.",
            "If you want to send one back to WeChat, copy and output its marker exactly as-is.",
            "Do not rewrite it as a filename, alias, natural language, or commands like !photobooth-photo.",
        ].join(" "));
    }
    for (const attachment of attachments) {
        lines.push(describeWechatAttachment(attachment));
        const marker = incomingAttachmentMarker(attachment);
        if (marker) {
            lines.push(marker);
        }
    }
    return lines.join("\n").trim();
}
export function riskyShellCommand(text) {
    const trimmed = text.trim().toLowerCase();
    return [
        /\brm\s+-rf\b/,
        /\bsudo\b/,
        /\bdel\s+\/[fsq]\b/,
        /\bformat\b/,
        /\bdiskpart\b/,
        /\bshutdown\b/,
        /\breboot\b/,
        />\s*\/dev\/sd[a-z]/,
        /\bmkfs\b/,
        /\bgit\s+reset\s+--hard\b/,
        /\bgit\s+clean\s+-fd/,
    ].some((pattern) => pattern.test(trimmed));
}
export function interactiveShellCommand(text) {
    if (/\b(vim|vi|nano|emacs|less|more|top|htop|ssh|ftp|sftp)\b/.test(text)) {
        return "This command appears to open an interactive program. Run it locally instead.";
    }
    return null;
}
export function classifyAttachment(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
        return "image";
    }
    if ([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"].includes(ext)) {
        return "voice";
    }
    if ([".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(ext)) {
        return "video";
    }
    return "file";
}
function attachmentMarkerForPath(filePath) {
    const trimmed = filePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
        return null;
    }
    try {
        const stat = fs.statSync(trimmed);
        if (!stat.isFile()) {
            return null;
        }
    }
    catch {
        return null;
    }
    return `[[${classifyAttachment(trimmed)}:${trimmed}]]`;
}
export function parseAttachments(text) {
    const files = [];
    const seen = new Set();
    const collect = (filePath) => {
        const trimmed = filePath.trim();
        const marker = attachmentMarkerForPath(trimmed);
        if (!marker) {
            return false;
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            files.push(trimmed);
        }
        return true;
    };
    let visible = text.replace(/\[\[(image|file|voice|video):([^\]]+)\]\]/gi, (_all, _kind, filePath) => {
        collect(String(filePath));
        return "";
    });
    visible = visible.replace(/\[([^\]\n]+)\]\((\/[^)\n]+)\)/g, (all, _label, filePath) => (collect(String(filePath)) ? "" : all));
    visible = visible.replace(/`([^`\n]+)`/g, (all, rawPath) => (collect(String(rawPath)) ? "" : all));
    return { visible: visible.trim(), files };
}
export function minimizeAttachmentReply(text) {
    const normalized = cleanTerminalText(text).trim();
    if (!normalized) {
        return "";
    }
    const filtered = normalized
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !isAttachmentBoilerplate(line));
    const compact = filtered.join("\n").trim();
    if (!compact) {
        return "";
    }
    if (/^[`'"“”‘’\[\](){}:：,，.。/\\\-_*\s]+$/.test(compact)) {
        return "";
    }
    return compact;
}
function isAttachmentBoilerplate(line) {
    if (/^(文件在这里|文件路径是|路径是|附件在这里|已上传|上传中)[:：]?$/i.test(line)) {
        return true;
    }
    if (/^(你可以在微信里|你在微信当前聊天里|在微信里选择|从桌面选|选择桌面).*/i.test(line)) {
        return true;
    }
    if (/^(我不能直接|不能直接把本机文件|没法替你|无法替你|不能替你).*(发|发送).*/i.test(line)) {
        return true;
    }
    if (/^(我试一下|我这边尝试|如果当前没有打开|我会先确认|通过网桥).*/i.test(line)) {
        return true;
    }
    if (/^(请在微信里|手动去微信|自己在微信里).*/i.test(line)) {
        return true;
    }
    return false;
}
//# sourceMappingURL=text.js.map