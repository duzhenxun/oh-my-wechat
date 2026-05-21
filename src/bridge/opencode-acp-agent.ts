import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Agent, AgentEvent, AgentState, ApprovalTicket, OmwMode } from "./types.ts";
import { cleanTerminalText, defaultCommand, now, preview, splitCommand } from "./text.ts";

type OpenCodeAcpAgentOptions = {
  mode: OmwMode;
  command?: string;
  cwd: string;
  args?: string[];
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type InitializeResponse = {
  protocolVersion?: number;
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
  agentInfo?: {
    name?: string;
    version?: string;
  };
};

type NewSessionResponse = {
  sessionId: string;
};

type PromptResponse = {
  stopReason?: string;
  userMessageId?: string | null;
};

type SessionNotification = {
  sessionId?: string;
  update?: SessionUpdate;
};

type SessionUpdate = {
  sessionUpdate?: string;
  content?: {
    type?: string;
    text?: string;
  };
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string }>;
};

type PermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

type RequestPermission = {
  sessionId?: string;
  options?: PermissionOption[];
  toolCall?: {
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
    locations?: Array<{ path?: string }>;
  };
};

const PROTOCOL_VERSION = 1;

export class OpenCodeAcpAgent implements Agent {
  private sink: (event: AgentEvent) => void = () => undefined;
  private server: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private sessionId: string | null = null;
  private authMethods: InitializeResponse["authMethods"] = [];
  private activePromptId: string | number | null = null;
  private finalChunks: string[] = [];
  private pendingApproval: {
    requestId: string | number | null;
    sessionId: string;
    options: PermissionOption[];
    ticket: ApprovalTicket;
  } | null = null;
  private readonly stateValue: AgentState;
  private readonly options: OpenCodeAcpAgentOptions;

  constructor(options: OpenCodeAcpAgentOptions) {
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

    this.setStatus("starting", "Starting OpenCode ACP...");
    const target = splitCommand(this.stateValue.command);
    const args = [...target.args, "acp", "--cwd", this.options.cwd];
    if (process.env.OH_MY_WECHAT_OPENCODE_DEBUG === "1") {
      args.push("--print-logs", "--log-level", "DEBUG");
    }

    this.server = spawn(target.file, args, {
      cwd: this.options.cwd,
      env: { ...process.env, OH_MY_WECHAT: "1" },
      stdio: "pipe",
    });

    if (typeof this.server.pid === "number") {
      this.stateValue.pid = this.server.pid;
    }
    this.stateValue.startedAt = now();

    this.server.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    this.server.stderr.on("data", (chunk) => this.handleStderr(chunk.toString("utf8")));
    this.server.once("exit", (code) => {
      this.server = null;
      this.sessionId = null;
      this.activePromptId = null;
      this.pendingApproval = null;
      this.stateValue.pendingApproval = null;
      delete this.stateValue.pid;
      this.rejectPending(`OpenCode ACP exited with code ${code ?? "unknown"}.`);
      this.setStatus(code === 0 ? "stopped" : "error", `OpenCode ACP exited with code ${code ?? "unknown"}.`);
    });
    this.server.once("error", (error) => {
      this.sink({ type: "failed", message: error.message, at: now() });
    });

    await this.initialize();
    await this.createSession();
    this.setStatus("idle", "OpenCode ACP is ready.");
  }

  async send(text: string): Promise<void> {
    if (!this.server || !this.sessionId) {
      throw new Error("opencode is not running.");
    }
    if (this.stateValue.status === "busy") {
      throw new Error("OpenCode 正在处理上一条消息，请等待当前回复完成，或发送 /stop 中断。");
    }
    if (this.pendingApproval) {
      throw new Error("An OpenCode approval is pending. Reply /yes or /no.");
    }

    const normalized = cleanTerminalText(text).trim();
    if (!normalized) {
      return;
    }

    this.finalChunks = [];
    this.stateValue.lastInputAt = now();
    this.setStatus("busy");

    const promptId = `msg-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const response = await this.request<PromptResponse>("session/prompt", {
      sessionId: this.sessionId,
      messageId: promptId,
      prompt: [{ type: "text", text: normalized }],
    });
    this.activePromptId = null;

    const finalText = cleanTerminalText(this.finalChunks.join("")).trim();
    this.stateValue.lastOutputAt = now();
    this.setStatus("idle", response.stopReason === "cancelled" ? "已发送中断。" : undefined);
    this.finalChunks = [];

    if (finalText) {
      this.sink({ type: "final", text: finalText, at: now() });
    }
  }

  async stop(): Promise<boolean> {
    if (!this.sessionId || this.stateValue.status !== "busy") {
      return false;
    }

    await this.notify("session/cancel", { sessionId: this.sessionId }).catch(() => undefined);
    this.activePromptId = null;
    this.pendingApproval = null;
    this.stateValue.pendingApproval = null;
    this.setStatus("idle", "已发送中断。");
    return true;
  }

  async approve(yes: boolean): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    const pending = this.pendingApproval;
    this.pendingApproval = null;
    this.stateValue.pendingApproval = null;
    this.setStatus("busy");

    const option = choosePermissionOption(pending.options, yes);
    const response = option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
    this.respond(pending.requestId, response);
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
    this.rejectPending("OpenCode ACP closed.");
    this.stdoutBuffer = "";
    this.sessionId = null;
    this.activePromptId = null;
    this.pendingApproval = null;
    this.stateValue.pendingApproval = null;
    this.finalChunks = [];
    const server = this.server;
    this.server = null;
    if (server) {
      server.kill();
    }
    this.setStatus("stopped", "OpenCode ACP closed.");
  }

  private async initialize(): Promise<void> {
    const response = await this.request<InitializeResponse>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: "oh-my-wechat",
        version: "0.0.0",
      },
      clientCapabilities: {},
    });

    this.authMethods = Array.isArray(response.authMethods) ? response.authMethods : [];
  }

  private async createSession(): Promise<void> {
    try {
      const response = await this.request<NewSessionResponse>("session/new", {
        cwd: this.options.cwd,
        mcpServers: [],
      });
      this.sessionId = response.sessionId;
    } catch (error) {
      throw new Error(this.describeSessionError(error));
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) {
        continue;
      }
      this.handleMessage(line);
    }
  }

  private handleStderr(text: string): void {
    const cleaned = cleanTerminalText(text);
    if (!cleaned.trim()) {
      return;
    }
    this.sink({ type: "output", stream: "stderr", text: cleaned, at: now() });
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.sink({ type: "output", stream: "stderr", text: `OpenCode ACP sent invalid JSON: ${line}\n`, at: now() });
      return;
    }

    if ("id" in parsed && ("result" in parsed || "error" in parsed) && !("method" in parsed)) {
      this.handleResponse(parsed as JsonRpcResponse);
      return;
    }

    if ("method" in parsed && "id" in parsed) {
      void this.handleRequest(parsed as JsonRpcRequest);
      return;
    }

    if ("method" in parsed) {
      this.handleNotification(parsed as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    this.pending.delete(key);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    if (message.method === "request_permission") {
      const params = asRequestPermission(message.params);
      const sessionId = params.sessionId ?? this.sessionId;
      if (!sessionId) {
        this.respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      const ticket = buildApprovalTicket(params, message.id);
      this.pendingApproval = {
        requestId: message.id,
        sessionId,
        options: params.options ?? [],
        ticket,
      };
      this.stateValue.pendingApproval = ticket;
      this.setStatus("awaiting_approval", "OpenCode approval is required.");
      this.sink({ type: "approval", ticket, at: now() });
      return;
    }

    this.respondError(message.id, -32601, `Unsupported ACP request: ${message.method}`);
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method !== "session/update") {
      return;
    }
    const notification = asSessionNotification(message.params);
    if (this.sessionId && notification.sessionId && notification.sessionId !== this.sessionId) {
      return;
    }
    const update = notification.update;
    if (!update || typeof update.sessionUpdate !== "string") {
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = extractTextChunk(update);
      if (!text) {
        return;
      }
      this.finalChunks.push(text);
      this.stateValue.lastOutputAt = now();
      this.sink({ type: "output", stream: "stdout", text, at: now() });
      return;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = extractTextChunk(update);
      if (!text) {
        return;
      }
      this.sink({ type: "output", stream: "stderr", text, at: now() });
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const summary = summarizeToolUpdate(update);
      if (summary) {
        this.sink({ type: "output", stream: "stderr", text: `${summary}\n`, at: now() });
      }
    }
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestId;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(String(id), { resolve: (value) => resolve(value as T), reject });
      try {
        this.writeMessage(message);
      } catch (error) {
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(message);
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if (!this.server?.stdin.writable) {
      throw new Error("OpenCode ACP is not writable.");
    }
    this.server.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private describeSessionError(error: unknown): string {
    const details = describeError(error);
    const authMethods = this.authMethods;
    if (!authMethods || authMethods.length === 0) {
      return details;
    }
    const names = authMethods.map((item) => item.name).filter(Boolean).join(", ");
    const descriptions = authMethods
      .map((item) => item.description)
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("；");
    const hints = [
      names ? `可用认证方式：${names}` : "",
      descriptions ? `提示：${descriptions}` : "",
    ].filter(Boolean);
    return [details, ...hints].join("\n");
  }

  private setStatus(status: AgentState["status"], message?: string): void {
    this.stateValue.status = status;
    this.sink({ type: "status", status, ...(message ? { message } : {}), at: now() });
  }
}

function asSessionNotification(value: unknown): SessionNotification {
  return isRecord(value) ? value as SessionNotification : {};
}

function asRequestPermission(value: unknown): RequestPermission {
  return isRecord(value) ? value as RequestPermission : {};
}

function extractTextChunk(update: SessionUpdate): string {
  const text = update.content?.type === "text" && typeof update.content.text === "string"
    ? update.content.text
    : "";
  return cleanTerminalText(text);
}

function summarizeToolUpdate(update: SessionUpdate): string | null {
  const parts: string[] = [];
  if (typeof update.title === "string" && update.title.trim()) {
    parts.push(update.title.trim());
  }
  if (typeof update.status === "string" && update.status.trim()) {
    parts.push(`[${update.status.trim()}]`);
  }
  if (Array.isArray(update.locations) && update.locations.length > 0) {
    const paths = update.locations
      .map((item) => item.path)
      .filter((item): item is string => typeof item === "string" && item.length > 0);
    if (paths.length > 0) {
      parts.push(paths.join(", "));
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

function choosePermissionOption(options: PermissionOption[], yes: boolean): PermissionOption | null {
  const preferredKinds = yes
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];

  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }

  if (yes) {
    return options[0] ?? null;
  }
  return options.find((option) => /reject|deny|decline|no/i.test(option.name ?? "")) ?? options[0] ?? null;
}

function buildApprovalTicket(request: RequestPermission, requestId: JsonRpcId): ApprovalTicket {
  const title = typeof request.toolCall?.title === "string" && request.toolCall.title.trim()
    ? request.toolCall.title.trim()
    : "OpenCode requests permission";
  const previewLines: string[] = [title];

  const kind = request.toolCall?.kind;
  if (typeof kind === "string" && kind.trim()) {
    previewLines.push(`kind: ${kind}`);
  }
  const status = request.toolCall?.status;
  if (typeof status === "string" && status.trim()) {
    previewLines.push(`status: ${status}`);
  }
  const rawInput = stringifyMaybe(request.toolCall?.rawInput);
  if (rawInput) {
    previewLines.push(`input: ${rawInput}`);
  }
  const rawOutput = stringifyMaybe(request.toolCall?.rawOutput);
  if (rawOutput) {
    previewLines.push(`output: ${rawOutput}`);
  }
  const optionLabels = (request.options ?? []).map((option) => option.name || option.kind || option.optionId).filter(Boolean);
  if (optionLabels.length > 0) {
    previewLines.push(`options: ${optionLabels.join(", ")}`);
  }

  return {
    id: `OPC-${String(requestId)}`,
    summary: title,
    preview: preview(previewLines.join("\n"), 800),
    createdAt: now(),
  };
}

function stringifyMaybe(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() ? value.trim() : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(value: unknown): string {
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
