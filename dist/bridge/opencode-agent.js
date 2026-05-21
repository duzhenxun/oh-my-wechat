import { spawn } from "node:child_process";
import net from "node:net";
import { cleanTerminalText, defaultCommand, now, preview, splitCommand } from "./text.js";
const HOST = "127.0.0.1";
export class OpenCodeAgent {
    sink = () => undefined;
    server = null;
    client = null;
    abortEvents = null;
    sessionId = null;
    workspaceId;
    activeMessageId = null;
    activeAssistantMessageId = null;
    pendingPermissionId = null;
    partTextById = new Map();
    finalText = "";
    stateValue;
    options;
    constructor(options) {
        this.options = options;
        this.stateValue = {
            mode: "opencode",
            command: options.command || defaultCommand("opencode"),
            cwd: options.cwd,
            status: "stopped",
        };
    }
    onEvent(sink) {
        this.sink = sink;
    }
    async start() {
        if (this.server) {
            return;
        }
        this.setStatus("starting", "Starting OpenCode server...");
        const port = await reservePort();
        const target = splitCommand(this.stateValue.command);
        this.server = spawn(target.file, [...target.args, "serve", "--port", String(port), "--hostname", HOST], {
            cwd: this.options.cwd,
            env: { ...process.env, OH_MY_WECHAT: "1" },
            stdio: "pipe",
        });
        if (typeof this.server.pid === "number") {
            this.stateValue.pid = this.server.pid;
        }
        this.stateValue.startedAt = now();
        this.server.stdout.on("data", (chunk) => this.emitDebug(chunk.toString("utf8")));
        this.server.stderr.on("data", (chunk) => this.emitDebug(chunk.toString("utf8")));
        this.server.once("exit", (code) => {
            this.server = null;
            delete this.stateValue.pid;
            this.setStatus(code === 0 ? "stopped" : "error", `OpenCode server exited with code ${code ?? "unknown"}.`);
        });
        this.server.once("error", (error) => {
            this.sink({ type: "failed", message: error.message, at: now() });
        });
        await waitForPort(port, 15_000);
        await this.createClient(port);
        await this.ensureSession();
        this.watchEvents();
        this.setStatus("idle", "OpenCode is ready.");
    }
    async send(text) {
        const client = this.client;
        if (!client) {
            throw new Error("opencode is not running.");
        }
        if (this.stateValue.status === "busy") {
            throw new Error("OpenCode 正在处理上一条消息，请等待当前回复完成，或发送 /stop 中断。");
        }
        if (this.pendingPermissionId) {
            throw new Error("An OpenCode approval is pending. Reply /yes or /no.");
        }
        const session = await this.ensureSession();
        const normalized = cleanTerminalText(text).trim();
        if (!normalized) {
            return;
        }
        this.stateValue.lastInputAt = now();
        this.setStatus("busy");
        this.activeMessageId = null;
        this.activeAssistantMessageId = null;
        this.partTextById.clear();
        this.finalText = "";
        const promptParams = {
            sessionID: session.id,
            directory: this.options.cwd,
            parts: [{ type: "text", text: normalized }],
        };
        const workspace = session.workspaceID ?? this.workspaceId;
        if (workspace) {
            promptParams.workspace = workspace;
        }
        const result = await client.session.promptAsync(promptParams);
        unwrapOrThrow(result, "OpenCode prompt failed");
    }
    async stop() {
        if (!this.client || !this.sessionId) {
            return false;
        }
        await this.client.session.abort({
            sessionID: this.sessionId,
            directory: this.options.cwd,
            ...(this.workspaceId ? { workspace: this.workspaceId } : {}),
        }).catch(() => undefined);
        this.pendingPermissionId = null;
        this.stateValue.pendingApproval = null;
        this.setStatus("idle", "已发送中断。");
        return true;
    }
    async approve(yes) {
        if (!this.client || !this.sessionId || !this.pendingPermissionId) {
            return false;
        }
        const result = await this.client.permission.respond({
            sessionID: this.sessionId,
            permissionID: this.pendingPermissionId,
            directory: this.options.cwd,
            ...(this.workspaceId ? { workspace: this.workspaceId } : {}),
            response: yes ? "once" : "reject",
        });
        unwrapOrThrow(result, "OpenCode permission response failed");
        this.pendingPermissionId = null;
        this.stateValue.pendingApproval = null;
        this.setStatus("busy");
        return true;
    }
    async reset() {
        await this.close();
        await this.start();
    }
    state() {
        return JSON.parse(JSON.stringify(this.stateValue));
    }
    async close() {
        this.abortEvents?.abort();
        this.abortEvents = null;
        const server = this.server;
        this.server = null;
        this.client = null;
        this.sessionId = null;
        this.workspaceId = undefined;
        this.activeMessageId = null;
        this.activeAssistantMessageId = null;
        this.pendingPermissionId = null;
        this.partTextById.clear();
        this.finalText = "";
        if (server) {
            server.kill();
        }
        this.setStatus("stopped", "OpenCode closed.");
    }
    async createClient(port) {
        const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
        const username = process.env.OPENCODE_SERVER_USERNAME?.trim();
        const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
        const auth = username && password ? `${username}:${password}` : undefined;
        this.client = createOpencodeClient({
            baseUrl: `http://${HOST}:${port}`,
            directory: this.options.cwd,
            ...(auth
                ? {
                    auth,
                    headers: {
                        Authorization: `Basic ${Buffer.from(auth, "utf8").toString("base64")}`,
                    },
                }
                : {}),
        });
    }
    async ensureSession() {
        if (!this.client) {
            throw new Error("opencode is not running.");
        }
        if (this.sessionId) {
            return {
                id: this.sessionId,
                directory: this.options.cwd,
                ...(this.workspaceId ? { workspaceID: this.workspaceId } : {}),
            };
        }
        let listed = [];
        try {
            listed = unwrapOrThrow(await this.client.session.list({ directory: this.options.cwd }), "OpenCode session list failed");
        }
        catch {
            listed = [];
        }
        const existing = listed
            .filter((item) => samePath(item.directory, this.options.cwd))
            .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
        if (existing) {
            this.sessionId = existing.id;
            this.workspaceId = existing.workspaceID;
            return existing;
        }
        const created = unwrapOrThrow(await this.client.session.create({ directory: this.options.cwd }), "OpenCode session create failed");
        this.sessionId = created.id;
        this.workspaceId = created.workspaceID;
        return created;
    }
    watchEvents() {
        if (!this.client || this.abortEvents) {
            return;
        }
        const abort = new AbortController();
        this.abortEvents = abort;
        void this.consumeEvents(abort).catch((error) => {
            if (!abort.signal.aborted) {
                this.sink({ type: "failed", message: `OpenCode event stream failed: ${describe(error)}`, at: now() });
            }
        });
    }
    async consumeEvents(abort) {
        const source = this.client?.event?.subscribe
            ? await this.client.event.subscribe({ directory: this.options.cwd }, { signal: abort.signal })
            : this.client?.global?.event
                ? await this.client.global.event({ signal: abort.signal })
                : null;
        if (!source) {
            return;
        }
        for await (const event of source.stream) {
            if (abort.signal.aborted) {
                return;
            }
            this.handleEvent(normalizeEvent(event));
        }
    }
    handleEvent(event) {
        if (!event) {
            return;
        }
        const type = normalizeEventType(event.type);
        const payload = extractEventPayload(event);
        const sessionId = extractSessionId(payload);
        if (this.sessionId && sessionId && sessionId !== this.sessionId) {
            return;
        }
        switch (type) {
            case "session.created":
            case "session.updated": {
                const session = extractSession(payload);
                if (session?.id) {
                    this.sessionId = session.id;
                    this.workspaceId = session.workspaceID ?? this.workspaceId;
                }
                return;
            }
            case "session.status": {
                const status = extractSessionStatus(payload);
                if (status?.type === "busy") {
                    this.setStatus("busy");
                }
                return;
            }
            case "session.idle": {
                this.finishActiveTurn();
                return;
            }
            case "permission.asked": {
                const request = extractPermissionRequest(payload);
                if (!request) {
                    return;
                }
                this.pendingPermissionId = request.id;
                const ticket = {
                    id: `OPC-${request.id}`,
                    summary: `OpenCode wants permission: ${request.permission}`,
                    preview: preview(buildPermissionPreview(request), 800),
                    createdAt: now(),
                };
                this.stateValue.pendingApproval = ticket;
                this.setStatus("awaiting_approval", "OpenCode approval is required.");
                this.sink({ type: "approval", ticket, at: now() });
                return;
            }
            case "permission.replied": {
                this.pendingPermissionId = null;
                this.stateValue.pendingApproval = null;
                if (this.stateValue.status === "awaiting_approval") {
                    this.setStatus("busy");
                }
                return;
            }
            case "message.updated": {
                const message = extractMessage(payload);
                if (!message) {
                    return;
                }
                if (message.role === "assistant") {
                    this.activeAssistantMessageId = message.id;
                }
                else if (!this.activeMessageId) {
                    this.activeMessageId = message.id;
                }
                if (message.error?.data?.message) {
                    this.setStatus("error", describeMessageError(message.error));
                }
                return;
            }
            case "message.part.updated": {
                const part = extractPart(payload);
                if (!part || part.type !== "text" || part.ignored === true) {
                    return;
                }
                if (this.activeAssistantMessageId && part.messageID !== this.activeAssistantMessageId) {
                    return;
                }
                const text = typeof part.text === "string" ? part.text : "";
                if (!text) {
                    return;
                }
                this.activeAssistantMessageId = part.messageID;
                const delta = diffText(this.partTextById.get(part.id) ?? "", text);
                this.partTextById.set(part.id, text);
                if (delta) {
                    this.finalText += delta;
                    this.stateValue.lastOutputAt = now();
                }
                return;
            }
            default:
                return;
        }
    }
    finishActiveTurn() {
        const text = cleanTerminalText(this.finalText).trim();
        this.pendingPermissionId = null;
        this.stateValue.pendingApproval = null;
        this.stateValue.lastOutputAt = now();
        this.setStatus("idle");
        this.partTextById.clear();
        this.finalText = "";
        this.activeMessageId = null;
        this.activeAssistantMessageId = null;
        if (text) {
            this.sink({ type: "final", text, at: now() });
        }
    }
    emitDebug(text) {
        if (process.env.OH_MY_WECHAT_OPENCODE_DEBUG && text.trim()) {
            this.sink({ type: "output", stream: "stderr", text, at: now() });
        }
    }
    setStatus(status, message) {
        this.stateValue.status = status;
        this.sink({ type: "status", status, ...(message ? { message } : {}), at: now() });
    }
}
async function reservePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, HOST, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Could not reserve a local port."));
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}
async function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect(port)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for OpenCode server on ${HOST}:${port}.`);
}
async function canConnect(port) {
    return await new Promise((resolve) => {
        const socket = net.connect({ host: HOST, port });
        const done = (value) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(250);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
    });
}
function unwrapOrThrow(result, context) {
    if (result.error !== undefined) {
        throw new Error(`${context}: ${describe(result.error)}`);
    }
    return result.data;
}
function normalizeEvent(event) {
    if (!isRecord(event)) {
        return null;
    }
    if (typeof event.type === "string") {
        return event;
    }
    if (isRecord(event.payload) && typeof event.payload.type === "string") {
        return event.payload;
    }
    return null;
}
function normalizeEventType(type) {
    return type.endsWith(".1") ? type.slice(0, -2) : type;
}
function extractEventPayload(event) {
    return asRecord(event.properties ?? event.data ?? event.payload);
}
function extractSessionId(record) {
    if (typeof record.sessionID === "string") {
        return record.sessionID;
    }
    if (isRecord(record.info) && typeof record.info.sessionID === "string") {
        return record.info.sessionID;
    }
    if (isRecord(record.session) && typeof record.session.id === "string") {
        return record.session.id;
    }
    return null;
}
function extractSession(record) {
    if (isRecord(record.info) && typeof record.info.id === "string" && typeof record.info.directory === "string") {
        return record.info;
    }
    if (typeof record.id === "string" && typeof record.directory === "string") {
        return record;
    }
    return null;
}
function extractSessionStatus(record) {
    return isRecord(record.status) && typeof record.status.type === "string"
        ? record.status
        : null;
}
function extractPermissionRequest(record) {
    if (typeof record.id !== "string" || typeof record.sessionID !== "string" || typeof record.permission !== "string") {
        return null;
    }
    const request = {
        id: record.id,
        sessionID: record.sessionID,
        permission: record.permission,
        patterns: Array.isArray(record.patterns) ? record.patterns.filter((v) => typeof v === "string") : [],
        metadata: isRecord(record.metadata) ? record.metadata : {},
        always: Array.isArray(record.always) ? record.always.filter((v) => typeof v === "string") : [],
    };
    if (isRecord(record.tool) && typeof record.tool.messageID === "string" && typeof record.tool.callID === "string") {
        request.tool = { messageID: record.tool.messageID, callID: record.tool.callID };
    }
    return request;
}
function extractMessage(record) {
    if (isRecord(record.info) && typeof record.info.id === "string" && typeof record.info.role === "string") {
        return record.info;
    }
    return null;
}
function extractPart(record) {
    if (isRecord(record.part) && typeof record.part.id === "string" && typeof record.part.messageID === "string") {
        return record.part;
    }
    return null;
}
function buildPermissionPreview(request) {
    const command = typeof request.metadata.command === "string" ? request.metadata.command : null;
    if (command) {
        return command;
    }
    if (request.patterns.length > 0) {
        return request.patterns.join("\n");
    }
    return JSON.stringify(request.metadata);
}
function diffText(previous, next) {
    const cleanedPrev = cleanTerminalText(previous);
    const cleanedNext = cleanTerminalText(next);
    if (cleanedNext === cleanedPrev) {
        return "";
    }
    if (cleanedNext.startsWith(cleanedPrev)) {
        return cleanedNext.slice(cleanedPrev.length);
    }
    return cleanedNext;
}
function describeMessageError(error) {
    const message = error.data?.message?.trim();
    if (error.name === "ProviderAuthError") {
        return error.data?.providerID
            ? `Authentication is required for provider \"${error.data.providerID}\".${message ? ` ${message}` : ""}`
            : message || "Authentication is required for the configured provider.";
    }
    return message || error.name || "OpenCode reported an error.";
}
function samePath(left, right) {
    const a = process.platform === "win32" ? left.toLowerCase() : left;
    const b = process.platform === "win32" ? right.toLowerCase() : right;
    return a === b;
}
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describe(value) {
    if (value instanceof Error) {
        return value.message;
    }
    if (typeof value === "object" && value !== null) {
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return String(value ?? "unknown error");
}
//# sourceMappingURL=opencode-agent.js.map