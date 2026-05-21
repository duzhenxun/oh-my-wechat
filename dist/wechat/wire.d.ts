import { type OmwAccount } from "./login.ts";
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
type WireOptions = {
    httpLog?: boolean;
};
export declare class WechatWire {
    private cursor;
    private contexts;
    private readonly claims;
    private readonly httpLogEnabled;
    private readonly log;
    private readonly workspaceCwd;
    constructor(log?: (line: string) => void, workspaceCwd?: string, options?: WireOptions);
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
    private httpLogContext;
    private updatesHttpLogContext;
    private logHttp;
    private materializeAttachments;
    private downloadIncomingAttachment;
    private buildIncomingAttachmentPath;
    private sendItems;
    private upload;
}
export {};
