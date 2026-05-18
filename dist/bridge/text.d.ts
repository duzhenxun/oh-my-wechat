import type { IncomingWechatAttachment } from "../wechat/wire.js";
export declare function now(): string;
export declare function cleanTerminalText(value: string): string;
export declare function preview(value: string, limit?: number): string;
export declare function humanStatus(lines: string[]): string;
export declare function defaultCommand(mode: string): string;
export declare function splitCommand(command: string): {
    file: string;
    args: string[];
};
export declare function promptForWechat(text: string, _cwd: string, attachments?: IncomingWechatAttachment[]): string;
export declare function riskyShellCommand(text: string): boolean;
export declare function interactiveShellCommand(text: string): string | null;
export declare function classifyAttachment(filePath: string): "image" | "voice" | "video" | "file";
export declare function parseAttachments(text: string): {
    visible: string;
    files: string[];
};
export declare function minimizeAttachmentReply(text: string): string;
