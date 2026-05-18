import { type OmwAccount } from "./login.js";
type AttachmentKind = "image" | "video" | "file" | "voice";
export type IncomingWechatAttachment = {
    kind: AttachmentKind;
    fileName?: string;
    downloadParam?: string;
    aesKey?: string;
    createdAtMs?: number;
    localPath?: string;
};
export type IncomingWechatText = {
    senderId: string;
    senderName: string;
    text: string;
    attachments: IncomingWechatAttachment[];
    sessionId: string;
    contextToken?: string;
    createdAt: string;
    createdAtMs?: number;
};
export declare class WechatWire {
    private readonly log;
    private readonly workspaceCwd;
    private cursor;
    private contexts;
    private readonly claims;
    constructor(log?: (line: string) => void, workspaceCwd?: string);
    account(): OmwAccount;
    statusText(): string;
    poll(timeoutMs?: number, minCreatedAtMs?: number): Promise<{
        messages: IncomingWechatText[];
        ignored: number;
    }>;
    sendText(text: string, recipientId?: string): Promise<string>;
    sendFile(filePath: string, recipientId?: string, label?: "file" | "image" | "voice" | "video"): Promise<string>;
    private resolveRecipient;
    private incomingMediaDir;
    private materializeAttachments;
    private downloadIncomingAttachment;
    private buildIncomingAttachmentPath;
    private sendItems;
    private upload;
}
export {};
