import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";

import type { Agent, AgentEvent, AgentState } from "./types.js";
import { cleanTerminalText, defaultCommand, now, preview, splitCommand } from "./text.js";

type CodexRemoteEndpoint = {
  command: string;
  url: string;
  tokenEnv: string;
  token: string;
  serverPid?: number;
};

type CodexRuntimeOptions = {
  command?: string;
  cwd: string;
  args?: string[];
};

const HOST = "127.0.0.1";
const TOKEN_ENV = "OH_MY_WECHAT_CODEX_REMOTE_TOKEN";
const DEBUG = process.env.OH_MY_WECHAT_CODEX_DEBUG === "1";

export class CodexRuntimeAgent implements Agent {
  private sink: (event: AgentEvent) => void = () => undefined;
  private server: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private requestId = 0;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private pendingTurnStartThreadId: string | null = null;
  private tokenFile: string | null = null;
  private token = "";
  private serverLog = "";
  private initialized = false;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  private finalTextByTurn = new Map<string, string[]>();
  private pendingApproval: {
    requestId: number | string;
    requestIdText: string;
    turnId: string | null;
    ticket: AgentState["pendingApproval"];
  } | null = null;
  private readonly stateValue: AgentState;

  constructor(private readonly options: CodexRuntimeOptions) {
    this.stateValue = {
      mode: "codex",
      command: options.command || defaultCommand("codex"),
      cwd: options.cwd,
      status: "stopped",
    };
  }

  private debug(message: string): void {
    if (!DEBUG) {
      return;
    }
    process.stderr.write(`[oh-my-wechat][codex] ${message}\n`);
  }

  onEvent(sink: (event: AgentEvent) => void): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.setStatus("starting", "Starting Codex app-server...");
    const port = await reservePort();
    this.token = crypto.randomBytes(24).toString("hex");
    this.tokenFile = path.join(os.tmpdir(), `oh-my-wechat-codex-${process.pid}-${Date.now()}.token`);
    fs.writeFileSync(this.tokenFile, `${this.token}\n`, "utf8");

    const target = splitCommand(this.stateValue.command);
    this.server = spawn(target.file, [
      ...target.args,
      "app-server",
      "--listen",
      `ws://${HOST}:${port}`,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      this.tokenFile,
    ], {
      cwd: this.options.cwd,
      env: buildEnv(),
      stdio: "pipe",
    });

    if (typeof this.server.pid === "number") {
      this.stateValue.pid = this.server.pid;
    }
    this.stateValue.startedAt = now();

    this.server.stdout.on("data", (chunk) => this.appendServerLog(chunk.toString("utf8")));
    this.server.stderr.on("data", (chunk) => this.appendServerLog(chunk.toString("utf8")));
    this.server.once("exit", (code) => {
      this.server = null;
      this.socket = null;
      this.initialized = false;
      this.threadId = null;
      this.activeTurnId = null;
      this.pendingTurnStartThreadId = null;
      this.pendingApproval = null;
      this.stateValue.pendingApproval = null;
      delete this.stateValue.pid;
      this.rejectPending("Codex app-server exited.");
      this.setStatus(code === 0 ? "stopped" : "error", `Codex app-server exited with code ${code ?? "unknown"}.`);
    });
    this.server.once("error", (error) => {
      this.sink({ type: "failed", message: error.message, at: now() });
    });

    await waitForPort(port, 10_000);
    await this.connect(`ws://${HOST}:${port}`);
    await this.initialize();
    await this.ensureThread();
    this.setStatus("idle", "Codex runtime is ready.");
  }

  async send(text: string): Promise<void> {
    if (!this.socket || !this.server) {
      throw new Error("codex is not running.");
    }
    if (this.stateValue.status === "busy") {
      throw new Error("codex 正在处理上一条消息，请等待当前回复完成，或发送 /stop 中断。");
    }
    if (this.pendingApproval) {
      throw new Error("A Codex approval is pending. Reply /yes or /no.");
    }

    const input = cleanTerminalText(text).trim();
    if (!input) {
      return;
    }

    const threadId = await this.ensureThread();
    this.debug(`send thread=${threadId} status=${this.stateValue.status} input=${preview(input, 120)}`);
    this.stateValue.lastInputAt = now();
    this.setStatus("busy");
    this.pendingTurnStartThreadId = threadId;

    try {
      const response = await this.rpc("turn/start", {
        threadId,
        cwd: this.options.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        input: [{ type: "text", text: input }],
      });
      const turnId = extractTurnEventId(response);
      if (turnId) {
        this.activeTurnId = turnId;
        this.debug(`turn/start acknowledged thread=${threadId} turn=${turnId}`);
      }
      this.pendingTurnStartThreadId = null;
    } catch (error) {
      this.pendingTurnStartThreadId = null;
      this.setStatus("idle");
      throw error;
    }
  }

  async stop(): Promise<boolean> {
    if (!this.activeTurnId) {
      return false;
    }

    const threadId = this.threadId;
    if (threadId) {
      await this.rpc("turn/interrupt", { threadId, turnId: this.activeTurnId }).catch(() => undefined);
    } else {
      await this.rpc("turn/abort", { turnId: this.activeTurnId }).catch(() => undefined);
    }

    this.finalTextByTurn.delete(this.activeTurnId);
    this.activeTurnId = null;
    this.pendingTurnStartThreadId = null;
    this.pendingApproval = null;
    this.stateValue.pendingApproval = null;
    this.setStatus("idle", "已发送中断。");
    return true;
  }

  async approve(yes: boolean): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    const requestId = this.pendingApproval.requestId;
    this.pendingApproval = null;
    this.stateValue.pendingApproval = null;
    this.setStatus("busy");
    this.sendRpcMessage({
      id: requestId,
      result: { decision: yes ? "accept" : "decline" },
    });
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
    this.rejectPending("Codex runtime closed.");
    this.finalTextByTurn.clear();
    this.pendingApproval = null;
    this.pendingTurnStartThreadId = null;
    this.stateValue.pendingApproval = null;
    this.socket?.close();
    this.socket = null;
    const server = this.server;
    this.server = null;
    server?.kill();
    this.initialized = false;
    this.threadId = null;
    this.activeTurnId = null;
    if (this.tokenFile) {
      fs.rmSync(this.tokenFile, { force: true });
      this.tokenFile = null;
    }
    this.setStatus("stopped", "Codex runtime closed.");
  }

  getRemoteEndpoint(): CodexRemoteEndpoint {
    if (!this.socket) {
      throw new Error("Codex runtime is not ready.");
    }
    const target = splitCommand(this.stateValue.command);
    return {
      command: target.file,
      url: this.socket.url,
      tokenEnv: TOKEN_ENV,
      token: this.token,
      ...(typeof this.server?.pid === "number" ? { serverPid: this.server.pid } : {}),
    };
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.rpc("initialize", {
      clientInfo: {
        name: "oh-my-wechat",
        title: "oh-my-wechat",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.initialized = true;
  }

  private async ensureThread(): Promise<string> {
    await this.initialize();
    if (this.threadId) {
      return this.threadId;
    }

    const response = await this.rpc("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "oh-my-wechat",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = extractThreadEventId(response);
    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }
    this.threadId = threadId;
    return threadId;
  }

  private async connect(url: string): Promise<void> {
    const connected = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}. ${this.serverLog}`)), 8_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${url}. ${this.serverLog}`));
      });
    });

    this.socket = connected;
    connected.on("message", (data) => this.handleMessage(data));
    connected.on("close", () => {
      this.socket = null;
      this.initialized = false;
      this.rejectPending("Codex websocket closed.");
      if (this.stateValue.status !== "stopped") {
        this.setStatus("error", "Codex websocket closed.");
      }
    });
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }
    const id = String(++this.requestId);
    this.debug(`rpc -> ${method} id=${id}`);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.sendRpcMessage({ id: Number(id), method, params });
    return await promise;
  }

  private sendRpcMessage(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    const record = asRecord(payload);
    const id = typeof record.id === "number" || typeof record.id === "string" ? String(record.id) : null;
    const method = typeof record.method === "string" ? record.method : null;

    if (id && !method) {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.debug(`rpc <- id=${id} ok=${record.error ? "no" : "yes"}`);
      this.pending.delete(id);
      if (record.error) {
        pending.reject(new Error(describe(record.error)));
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (id && method) {
      this.handleServerRequest(id, method, record.params);
      return;
    }

    if (method) {
      this.handleNotification(method, record.params);
    }
  }

  private handleServerRequest(id: string, method: string, params: unknown): void {
    if (!method.includes("requestApproval")) {
      this.sendRpcMessage({
        id: Number(id),
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
      return;
    }

    const requestIdText = String(id);
    const ticket = {
      id: `CDX-${requestIdText}`,
      summary: approvalSummary(method, params),
      preview: approvalPreview(params),
      createdAt: now(),
    };
    this.pendingApproval = {
      requestId: Number(id),
      requestIdText,
      turnId: this.activeTurnId,
      ticket,
    };
    this.stateValue.pendingApproval = ticket;
    this.setStatus("awaiting_approval", "Codex approval is required.");
    this.sink({ type: "approval", ticket, at: now() });
  }

  private handleNotification(method: string, params: unknown): void {
    const record = asRecord(params);
    const threadId = extractThreadEventId(record);
    const turnId = extractTurnEventId(record);

    this.debug(`notify ${method} thread=${threadId ?? "-"} turn=${turnId ?? "-"} currentThread=${this.threadId ?? "-"} activeTurn=${this.activeTurnId ?? "-"}`);

    if (threadId && this.threadId && threadId !== this.threadId) {
      this.debug(`ignore foreign thread event method=${method} thread=${threadId}`);
      return;
    }

    if (method === "thread/started") {
      if (threadId && this.pendingTurnStartThreadId && threadId === this.pendingTurnStartThreadId) {
        this.threadId = threadId;
        this.pendingTurnStartThreadId = null;
      }
      return;
    }

    if (method === "thread/status/changed") {
      return;
    }

    if (method === "turn/started") {
      if (turnId && !this.activeTurnId && this.pendingTurnStartThreadId && (!threadId || threadId === this.pendingTurnStartThreadId)) {
        this.activeTurnId = turnId;
      }
      if (turnId && this.activeTurnId && turnId === this.activeTurnId) {
        this.setStatus("busy");
      }
      return;
    }

    if (method === "item/agentMessage/delta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      if (!turnId || !this.activeTurnId || turnId !== this.activeTurnId) {
        return;
      }
      const delta = extractDeltaText(record);
      if (!delta) {
        return;
      }
      this.stateValue.lastOutputAt = now();
      this.sink({ type: "output", stream: "stdout", text: delta, at: now() });
      return;
    }

    if (method === "item/completed") {
      if (!turnId || !this.activeTurnId || turnId !== this.activeTurnId) {
        return;
      }
      const item = asRecord(record.item);
      const finalText = extractFinalText(item);
      if (finalText) {
        const list = this.finalTextByTurn.get(turnId) ?? [];
        list.push(finalText);
        this.finalTextByTurn.set(turnId, list);
      }
      return;
    }

    if (method === "serverRequest/resolved") {
      if (!matchesPendingApproval(record, this.pendingApproval)) {
        return;
      }
      this.pendingApproval = null;
      this.stateValue.pendingApproval = null;
      if (this.stateValue.status === "awaiting_approval") {
        this.setStatus("busy");
      }
      return;
    }

    if (method === "turn/completed") {
      if (!turnId || !this.activeTurnId || turnId !== this.activeTurnId) {
        return;
      }
      const text = (this.finalTextByTurn.get(turnId) ?? []).join("\n\n").trim();
      this.finalTextByTurn.delete(turnId);
      this.activeTurnId = null;
      this.pendingApproval = null;
      this.stateValue.pendingApproval = null;
      this.stateValue.lastOutputAt = now();
      this.setStatus("idle");
      this.sink({
        type: "final",
        text: text || `Codex 已完成当前回合（turn ${turnId}），但没有返回可转发到微信的最终文本。`,
        at: now(),
      });
      return;
    }

    if (method === "error") {
      this.pendingApproval = null;
      this.stateValue.pendingApproval = null;
      this.pendingTurnStartThreadId = null;
      if (turnId && this.activeTurnId === turnId) {
        this.finalTextByTurn.delete(turnId);
        this.activeTurnId = null;
      }
      this.setStatus("error", describe(record.error ?? record));
    }
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private appendServerLog(text: string): void {
    this.serverLog = `${this.serverLog}${text}`.slice(-8_000);
  }

  private setStatus(status: AgentState["status"], message?: string): void {
    this.debug(`status ${this.stateValue.status} -> ${status}${message ? ` message=${message}` : ""}`);
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
        reject(new Error("Could not reserve port."));
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
  throw new Error(`Timed out waiting for Codex app-server on ${HOST}:${port}.`);
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

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = env.TERM || "xterm-256color";
  env.NO_PROXY = mergeNoProxy(env.NO_PROXY);
  env.no_proxy = mergeNoProxy(env.no_proxy);
  return env;
}

function mergeNoProxy(value?: string): string {
  const parts = new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  parts.add("127.0.0.1");
  parts.add("localhost");
  parts.add("::1");
  return [...parts].join(",");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractId(value: unknown, keys: string[]): string | null {
  const record = asRecord(value);
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  for (const nestedKey of ["thread", "turn", "request"]) {
    const nested = asRecord(record[nestedKey]);
    for (const key of keys) {
      if (typeof nested[key] === "string") {
        return nested[key];
      }
    }
  }
  return null;
}

function extractThreadEventId(value: unknown): string | null {
  const record = asRecord(value);
  return firstString(
    record.threadId,
    record.thread_id,
    asRecord(record.thread).id,
    asRecord(record.thread).threadId,
    asRecord(record.thread).thread_id,
  );
}

function extractTurnEventId(value: unknown): string | null {
  const record = asRecord(value);
  return firstString(
    record.turnId,
    record.turn_id,
    asRecord(record.turn).id,
    asRecord(record.turn).turnId,
    asRecord(record.turn).turn_id,
  );
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}

function extractDeltaText(value: Record<string, unknown>): string {
  const delta = typeof value.delta === "string"
    ? value.delta
    : typeof asRecord(value.item).delta === "string"
      ? String(asRecord(value.item).delta)
      : typeof asRecord(value.payload).delta === "string"
        ? String(asRecord(value.payload).delta)
        : "";
  return cleanTerminalText(delta);
}

function extractFinalText(item: Record<string, unknown>): string | null {
  if (item.type !== "agentMessage" || item.phase !== "final_answer") {
    return null;
  }
  const text = typeof item.text === "string"
    ? cleanTerminalText(item.text).trim()
    : typeof item.message === "string"
      ? cleanTerminalText(item.message).trim()
      : "";
  return text || null;
}

function approvalSummary(method: string, params: unknown): string {
  const record = asRecord(params);
  const command = typeof record.command === "string" ? record.command : null;
  if (command) {
    return "Codex wants to run a command.";
  }
  if (method.includes("fileChange")) {
    return "Codex wants to apply file changes.";
  }
  return "Codex needs approval to continue.";
}

function approvalPreview(params: unknown): string {
  const record = asRecord(params);
  const command = typeof record.command === "string"
    ? record.command
    : typeof asRecord(record.metadata).command === "string"
      ? String(asRecord(record.metadata).command)
      : null;
  if (command) {
    return preview(command, 800);
  }
  return preview(describe(params), 800);
}


function matchesPendingApproval(
  record: Record<string, unknown>,
  pending: {
    requestIdText: string;
    turnId: string | null;
  } | null,
): boolean {
  if (!pending) {
    return false;
  }

  const requestId = typeof record.requestId === "string" || typeof record.request_id === "string"
    ? String(record.requestId ?? record.request_id)
    : typeof record.id === "number" || typeof record.id === "string"
      ? String(record.id)
      : typeof asRecord(record.request).id === "number" || typeof asRecord(record.request).id === "string"
        ? String(asRecord(record.request).id)
        : null;
  if (requestId && requestId !== pending.requestIdText) {
    return false;
  }

  const turnId = extractTurnEventId(record);
  if (pending.turnId && turnId && turnId !== pending.turnId) {
    return false;
  }

  return true;
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
  return String(value ?? "unknown");
}
