import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { Agent, AgentEvent, AgentState, ApprovalTicket, OmwMode } from "./types.js";
import { defaultCommand, now, preview, splitCommand } from "./text.js";

type ClaudePrintAgentOptions = {
  mode: OmwMode;
  command?: string;
  cwd: string;
  args?: string[];
};

type ClaudePermissionDenied = {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
};

type ClaudePrintResult = {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
  permission_denials?: ClaudePermissionDenied[];
};

type ClaudeRunResult = {
  parsed: ClaudePrintResult;
  stderr: string;
};

type ClaudeRunOptions = {
  resumeSessionId?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  allowedTools?: string[];
  disallowedTools?: string[];
};

type PendingClaudeApproval = {
  permissionDenials: ClaudePermissionDenied[];
  sessionId: string;
  originalPrompt: string;
};

export class ClaudePrintAgent implements Agent {
  private sink: (event: AgentEvent) => void = () => undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private pendingApprovalState: PendingClaudeApproval | null = null;
  private readonly stateValue: AgentState;

  constructor(private readonly options: ClaudePrintAgentOptions) {
    this.stateValue = {
      mode: "claude",
      command: options.command || defaultCommand("claude"),
      cwd: options.cwd,
      status: "stopped",
    };
  }

  onEvent(sink: (event: AgentEvent) => void): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
    if (this.stateValue.status !== "stopped" && this.stateValue.status !== "error") {
      return;
    }
    this.stateValue.startedAt = now();
    this.setStatus("idle", "Claude is ready.");
  }

  async send(text: string): Promise<void> {
    if (this.child) {
      throw new Error("claude 正在处理上一条消息，请等待当前回复完成，或发送 /stop 中断。");
    }
    if (this.pendingApprovalState) {
      throw new Error("Claude 正在等待你确认操作，请回复 /yes 或 /no。");
    }

    const prompt = text.trim();
    if (!prompt) {
      return;
    }

    this.stateValue.lastInputAt = now();
    this.setStatus("busy");

    try {
      const result = await this.runClaude(prompt);
      this.handleClaudeResult(result, prompt);
    } catch (error) {
      if (this.stateValue.status !== "awaiting_approval") {
        this.setStatus("idle");
      }
      throw error;
    }
  }

  async stop(): Promise<boolean> {
    if (this.pendingApprovalState) {
      this.pendingApprovalState = null;
      this.stateValue.pendingApproval = null;
      this.setStatus("idle", "已取消待确认操作。");
      return true;
    }
    if (!this.child) {
      return false;
    }
    this.child.kill("SIGINT");
    this.child = null;
    delete this.stateValue.pid;
    this.setStatus("idle", "已发送中断。");
    return true;
  }

  async approve(yes: boolean): Promise<boolean> {
    const pending = this.pendingApprovalState;
    if (!pending) {
      return false;
    }

    this.pendingApprovalState = null;
    this.stateValue.pendingApproval = null;
    this.setStatus("busy");

    const toolNames = uniqueToolNames(pending.permissionDenials);
    void this.continueAfterApproval(pending, yes, toolNames);
    return true;
  }

  async reset(): Promise<void> {
    await this.close();
    this.sessionId = null;
    this.pendingApprovalState = null;
    this.stateValue.pendingApproval = null;
    this.stateValue.startedAt = now();
    this.setStatus("idle", "Claude session reset.");
  }

  state(): AgentState {
    return JSON.parse(JSON.stringify(this.stateValue)) as AgentState;
  }

  async close(): Promise<void> {
    this.pendingApprovalState = null;
    this.stateValue.pendingApproval = null;
    const child = this.child;
    this.child = null;
    delete this.stateValue.pid;
    child?.kill();
    this.setStatus("stopped", "Claude closed.");
  }

  private async continueAfterApproval(
    pending: PendingClaudeApproval,
    approved: boolean,
    toolNames: string[],
  ): Promise<void> {
    try {
      const result = await this.runClaude(pending.originalPrompt, {
        resumeSessionId: pending.sessionId,
        ...(approved
          ? {
              permissionMode: "bypassPermissions" as const,
              ...(toolNames.length > 0 ? { allowedTools: toolNames } : {}),
            }
          : {
              permissionMode: "dontAsk" as const,
            }),
      });
      this.handleClaudeResult(result, pending.originalPrompt, approved);
    } catch (error) {
      this.setStatus("idle");
      this.sink({ type: "failed", message: errorMessage(error), at: now() });
    }
  }

  private async runClaude(prompt: string, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    const target = splitCommand(this.stateValue.command);
    const args = [
      ...target.args,
      "-p",
      "--output-format",
      "json",
      ...(options.resumeSessionId
        ? ["-r", options.resumeSessionId]
        : this.sessionId
          ? ["-r", this.sessionId]
          : []),
      ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
      ...(options.allowedTools && options.allowedTools.length > 0
        ? ["--allowedTools", options.allowedTools.join(",")]
        : []),
      ...(options.disallowedTools && options.disallowedTools.length > 0
        ? ["--disallowedTools", options.disallowedTools.join(",")]
        : []),
      ...(this.options.args ?? []),
      "--",
      prompt,
    ];

    const child = spawn(target.file, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        OH_MY_WECHAT: "1",
      },
      stdio: "pipe",
    });

    this.child = child;
    if (typeof child.pid === "number") {
      this.stateValue.pid = child.pid;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        this.child = null;
        delete this.stateValue.pid;
        if (code !== 0) {
          reject(new Error((stderr || stdout || `claude exited with code ${code ?? "unknown"}`).trim()));
          return;
        }
        resolve();
      });
    });

    const parsed = parseClaudeJson(stdout);
    if (!parsed) {
      throw new Error((stderr || stdout || "Claude did not return valid JSON output.").trim());
    }

    return { parsed, stderr };
  }

  private handleClaudeResult(
    { parsed, stderr }: ClaudeRunResult,
    prompt: string,
    fromApprovalDecision?: boolean,
  ): void {
    if (parsed.session_id) {
      this.sessionId = parsed.session_id;
    }

    const permissionDenials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [];
    if (permissionDenials.length > 0) {
      if (fromApprovalDecision === false) {
        this.stateValue.lastOutputAt = now();
        this.setStatus("idle");
        const finalText = typeof parsed.result === "string" ? parsed.result.trim() : "";
        if (finalText) {
          this.sink({ type: "final", text: finalText, at: now() });
          return;
        }
        if (stderr.trim()) {
          this.sink({ type: "final", text: stderr.trim(), at: now() });
        }
        return;
      }

      const sessionId = parsed.session_id || this.sessionId;
      if (!sessionId) {
        this.setStatus("idle");
        this.sink({
          type: "failed",
          message: "Claude 请求权限确认，但当前没有可恢复的 session_id。",
          at: now(),
        });
        return;
      }
      const ticket = buildApprovalTicket(permissionDenials);
      this.pendingApprovalState = {
        permissionDenials,
        sessionId,
        originalPrompt: prompt,
      };
      this.stateValue.pendingApproval = ticket;
      this.stateValue.lastOutputAt = now();
      this.setStatus("awaiting_approval", "Claude 正在等待微信确认。请回复 /yes 或 /no。");
      this.sink({ type: "approval", ticket, at: now() });
      return;
    }

    this.stateValue.lastOutputAt = now();
    this.setStatus("idle");

    const finalText = typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (finalText) {
      this.sink({ type: "final", text: finalText, at: now() });
      return;
    }

    if (stderr.trim()) {
      this.sink({ type: "final", text: stderr.trim(), at: now() });
    }
  }

  private setStatus(status: AgentState["status"], message?: string): void {
    this.stateValue.status = status;
    this.sink({ type: "status", status, ...(message ? { message } : {}), at: now() });
  }
}

function parseClaudeJson(text: string): ClaudePrintResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as ClaudePrintResult;
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index] as string) as ClaudePrintResult;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function buildApprovalTicket(denials: ClaudePermissionDenied[]): ApprovalTicket {
  const first = denials[0] ?? {};
  const toolName = typeof first.tool_name === "string" && first.tool_name.trim()
    ? first.tool_name.trim()
    : "tool";
  const target = approvalTarget(first);
  return {
    id: `CLD-${toolName.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    summary: `Claude 请求使用 ${toolName}${target ? `：${target.summary}` : ""}`,
    preview: target ? target.preview : "等待微信确认后继续执行。",
    createdAt: now(),
  };
}

function approvalTarget(denial: ClaudePermissionDenied): { summary: string; preview: string } | null {
  const input = denial.tool_input ?? {};
  if (typeof input.command === "string" && input.command.trim()) {
    const command = input.command.trim();
    return {
      summary: preview(command, 80),
      preview: preview(command, 800),
    };
  }
  if (typeof input.file_path === "string" && input.file_path.trim()) {
    const filePath = input.file_path.trim();
    return {
      summary: filePath,
      preview: filePath,
    };
  }
  return null;
}

function uniqueToolNames(denials: ClaudePermissionDenied[]): string[] {
  return [...new Set(
    denials
      .map((item) => (typeof item.tool_name === "string" ? item.tool_name.trim() : ""))
      .filter(Boolean),
  )];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
