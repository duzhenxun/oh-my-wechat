import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";

import type { Agent, AgentEvent, AgentState, OmwMode } from "./types.ts";
import { cleanTerminalText, defaultCommand, now, preview, splitCommand } from "./text.ts";

type SdkResult<T> = ({
  data: T;
  error: undefined;
} | {
  data: undefined;
  error: unknown;
}) & {
  request: Request;
  response: Response;
};

type SdkSession = {
  id: string;
  directory: string;
  workspaceID?: string;
  title?: string;
  time?: { updated?: number };
};

type SdkSessionStatus = {
  type: "idle" | "busy" | "retry" | string;
};

type SdkPermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

type SdkMessage = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  error?: {
    name?: string;
    data?: { message?: string; providerID?: string };
  };
};

type SdkPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  ignored?: boolean;
};

type SdkEvent = {
  type: string;
  properties?: unknown;
  data?: unknown;
  payload?: unknown;
};

type OpenCodeClient = {
  session: {
    list(parameters?: Record<string, unknown>): Promise<SdkResult<SdkSession[]>>;
    create(parameters?: Record<string, unknown>): Promise<SdkResult<SdkSession>>;
    abort(parameters: Record<string, unknown>): Promise<SdkResult<unknown>>;
    promptAsync(parameters: {
      sessionID: string;
      directory?: string;
      workspace?: string;
      parts?: Array<{ type: string; text: string }>;
    }): Promise<SdkResult<unknown>>;
  };
  permission: {
    respond(parameters: {
      sessionID: string;
      permissionID: string;
      directory?: string;
      workspace?: string;
      response?: "once" | "always" | "reject";
    }): Promise<SdkResult<boolean>>;
  };
  event?: {
    subscribe(parameters?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  global?: {
    event(options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<unknown> }>;
  };
};

type OpenCodeAgentOptions = {
  mode: OmwMode;
  command?: string;
  cwd: string;
  args?: string[];
};

const HOST = "127.0.0.1";

export class OpenCodeAgent implements Agent {
  private sink: (event: AgentEvent) => void = () => undefined;
  private server: ChildProcessWithoutNullStreams | null = null;
  private client: OpenCodeClient | null = null;
  private abortEvents: AbortController | null = null;
  private sessionId: string | null = null;
  private workspaceId: string | undefined;
  private activeMessageId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private pendingPermissionId: string | null = null;
  private partTextById = new Map<string, string>();
  private finalText = "";
  private readonly stateValue: AgentState;
  private readonly options: OpenCodeAgentOptions;

  constructor(options: OpenCodeAgentOptions) {
    this.options = options;
    this.stateValue = {
      mode: "opencode",
      command: options.command || defaultCommand("opencode"),
      cwd: options.cwd,
      status: "stopped",
    };
  }

  onEvent(sink: (event: AgentEvent) => void): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
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

  async send(text: string): Promise<void> {
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

    const promptParams: {
      sessionID: string;
      directory?: string;
      workspace?: string;
      parts?: Array<{ type: string; text: string }>;
    } = {
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

  async stop(): Promise<boolean> {
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

  async approve(yes: boolean): Promise<boolean> {
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

  async reset(): Promise<void> {
    await this.close();
    await this.start();
  }

  state(): AgentState {
    return JSON.parse(JSON.stringify(this.stateValue)) as AgentState;
  }

  async close(): Promise<void> {
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

  private async createClient(port: number): Promise<void> {
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
    }) as unknown as OpenCodeClient;
  }

  private async ensureSession(): Promise<SdkSession> {
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

    let listed: SdkSession[] = [];
    try {
      listed = unwrapOrThrow(await this.client.session.list({ directory: this.options.cwd }), "OpenCode session list failed");
    } catch {
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

    const created = unwrapOrThrow(
      await this.client.session.create({ directory: this.options.cwd }),
      "OpenCode session create failed",
    );
    this.sessionId = created.id;
    this.workspaceId = created.workspaceID;
    return created;
  }

  private watchEvents(): void {
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

  private async consumeEvents(abort: AbortController): Promise<void> {
    const source =
      this.client?.event?.subscribe
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

  private handleEvent(event: SdkEvent | null): void {
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
        } else if (!this.activeMessageId) {
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

  private finishActiveTurn(): void {
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

  private emitDebug(text: string): void {
    if (process.env.OH_MY_WECHAT_OPENCODE_DEBUG && text.trim()) {
      this.sink({ type: "output", stream: "stderr", text, at: now() });
    }
  }

  private setStatus(status: AgentState["status"], message?: string): void {
    this.stateValue.status = status;
    this.sink({ type: "status", status, ...(message ? { message } : {}), at: now() });
  }
}

async function reservePort(): Promise<number> {
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

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for OpenCode server on ${HOST}:${port}.`);
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function unwrapOrThrow<T>(result: SdkResult<T>, context: string): T {
  if (result.error !== undefined) {
    throw new Error(`${context}: ${describe(result.error)}`);
  }
  return result.data as T;
}

function normalizeEvent(event: unknown): SdkEvent | null {
  if (!isRecord(event)) {
    return null;
  }
  if (typeof event.type === "string") {
    return event as SdkEvent;
  }
  if (isRecord(event.payload) && typeof event.payload.type === "string") {
    return event.payload as SdkEvent;
  }
  return null;
}

function normalizeEventType(type: string): string {
  return type.endsWith(".1") ? type.slice(0, -2) : type;
}

function extractEventPayload(event: SdkEvent): Record<string, unknown> {
  return asRecord(event.properties ?? event.data ?? event.payload);
}

function extractSessionId(record: Record<string, unknown>): string | null {
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

function extractSession(record: Record<string, unknown>): SdkSession | null {
  if (isRecord(record.info) && typeof record.info.id === "string" && typeof record.info.directory === "string") {
    return record.info as unknown as SdkSession;
  }
  if (typeof record.id === "string" && typeof record.directory === "string") {
    return record as unknown as SdkSession;
  }
  return null;
}

function extractSessionStatus(record: Record<string, unknown>): SdkSessionStatus | null {
  return isRecord(record.status) && typeof record.status.type === "string"
    ? record.status as SdkSessionStatus
    : null;
}

function extractPermissionRequest(record: Record<string, unknown>): SdkPermissionRequest | null {
  if (typeof record.id !== "string" || typeof record.sessionID !== "string" || typeof record.permission !== "string") {
    return null;
  }
  const request: SdkPermissionRequest = {
    id: record.id,
    sessionID: record.sessionID,
    permission: record.permission,
    patterns: Array.isArray(record.patterns) ? record.patterns.filter((v): v is string => typeof v === "string") : [],
    metadata: isRecord(record.metadata) ? record.metadata : {},
    always: Array.isArray(record.always) ? record.always.filter((v): v is string => typeof v === "string") : [],
  };
  if (isRecord(record.tool) && typeof record.tool.messageID === "string" && typeof record.tool.callID === "string") {
    request.tool = { messageID: record.tool.messageID, callID: record.tool.callID };
  }
  return request;
}

function extractMessage(record: Record<string, unknown>): SdkMessage | null {
  if (isRecord(record.info) && typeof record.info.id === "string" && typeof record.info.role === "string") {
    return record.info as unknown as SdkMessage;
  }
  return null;
}

function extractPart(record: Record<string, unknown>): SdkPart | null {
  if (isRecord(record.part) && typeof record.part.id === "string" && typeof record.part.messageID === "string") {
    return record.part as unknown as SdkPart;
  }
  return null;
}

function buildPermissionPreview(request: SdkPermissionRequest): string {
  const command = typeof request.metadata.command === "string" ? request.metadata.command : null;
  if (command) {
    return command;
  }
  if (request.patterns.length > 0) {
    return request.patterns.join("\n");
  }
  return JSON.stringify(request.metadata);
}

function diffText(previous: string, next: string): string {
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

function describeMessageError(error: { name?: string; data?: { message?: string; providerID?: string } }): string {
  const message = error.data?.message?.trim();
  if (error.name === "ProviderAuthError") {
    return error.data?.providerID
      ? `Authentication is required for provider \"${error.data.providerID}\".${message ? ` ${message}` : ""}`
      : message || "Authentication is required for the configured provider.";
  }
  return message || error.name || "OpenCode reported an error.";
}

function samePath(left: string, right: string): boolean {
  const a = process.platform === "win32" ? left.toLowerCase() : left;
  const b = process.platform === "win32" ? right.toLowerCase() : right;
  return a === b;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "unknown error");
}
