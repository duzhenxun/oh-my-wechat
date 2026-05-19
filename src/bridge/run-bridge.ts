#!/usr/bin/env node

import path from "node:path";

import {
  acquireBridgeLock,
  clearCodexRuntimeEndpoint,
  killOtherBridges,
  releaseBridgeLock,
  writeCodexRuntimeEndpoint,
} from "../wechat/paths.js";
import { ensureLogin } from "../wechat/login.js";
import { WechatWire } from "../wechat/wire.js";
import { readLocalPackageInfo } from "../cli/version.js";
import { CodexRuntimeAgent } from "./codex-runtime-agent.js";
import { ClaudePrintAgent } from "./claude-print-agent.js";
import { OpenCodeAgent } from "./opencode-agent.js";
import { TerminalAgent } from "./terminal-agent.js";
import type { Agent, AgentEvent, OmwMode } from "./types.js";
import {
  classifyAttachment,
  cleanTerminalText,
  humanStatus,
  minimizeAttachmentReply,
  parseAttachments,
  preview,
  promptForWechat,
} from "./text.js";

type BridgeOptions = {
  mode: OmwMode;
  command?: string;
  cwd: string;
  args: string[];
};

type PendingWechatMessage = {
  senderId: string;
  senderName: string;
  text: string;
  attachments: Parameters<typeof promptForWechat>[2];
};

const POLL_RETRY_MIN = 1_000;
const POLL_RETRY_MAX = 30_000;
const PKG = readLocalPackageInfo();

type LocalLogKind = "system" | "user" | "agent";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[90m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_CODE = "\x1b[38;5;111m";
const ANSI_WHITE = "\x1b[97m";

function localTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function paint(text: string, color: string): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

function highlightTerminalTokens(text: string, color: string): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR) {
    return text;
  }

  const withInlineCode = text.replace(/`([^`]+)`/g, (_match, code: string) => `${color}${code}${ANSI_RESET}`);
  return withInlineCode.replace(
    /(^|[^\w./-])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?::\d+)?)(?=$|[^\w./:-])/g,
    (_match, prefix: string, token: string) => `${prefix}${color}${token}${ANSI_RESET}`,
  );
}

function formatLocalLine(line: string, kind: LocalLogKind, mode?: OmwMode): string {
  const stamp = paint(`[${localTimestamp()}]`, ANSI_WHITE);
  if (kind === "agent") {
    const label = paint(`[${mode ?? "agent"}]`, ANSI_YELLOW);
    const body = highlightTerminalTokens(line, ANSI_CODE);
    return `${stamp} ${label} ${body}`;
  }
  const label = paint("[oh-my-wechat]", ANSI_DIM);
  const body = kind === "user"
    ? paint(line, ANSI_CYAN)
    : paint(line, ANSI_DIM);
  return `${stamp} ${label} ${body}`;
}

function log(line: string, kind: LocalLogKind = "system"): void {
  process.stderr.write(`${formatLocalLine(line, kind)}\n`);
}

export function parseArgs(argv: string[]): BridgeOptions {
  let mode: OmwMode = "codex";
  let command: string | undefined;
  let cwd = process.cwd();
  const args: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    }
    if (arg === "--mode" || arg === "--adapter") {
      if (!next || !["codex", "claude", "opencode", "shell"].includes(next)) {
        throw new Error(`Invalid mode: ${next ?? "(missing)"}`);
      }
      mode = next as OmwMode;
      i += 1;
      continue;
    }
    if (arg === "--command") {
      if (!next) {
        throw new Error("--command requires a value");
      }
      command = next;
      i += 1;
      continue;
    }
    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg) {
      args.push(arg);
    }
  }

  return {
    mode,
    ...(command ? { command } : {}),
    cwd,
    args,
  };
}

function helpText(): string {
  return [
    "快捷指令：",
    "/h 帮助   /status 状态",
    "/stop 中断   /new 新会话",
    "",
    "审批回复：",
    "y / n   1 / 0   同意 / 拒绝",
  ].join("\n");
}

function bridgeOnlineText(mode: OmwMode, cwd: string, version: string): string {
  return [
    "你好！👋 很高兴见到你！",
    "我是 oh-my-wechat，简称 omw，你的 AI 助手。",
    "我可以帮你处理这些事情：",
    "- 文件操作：读取、编辑、搜索文件",
    "- 终端命令：执行 shell 命令、管理进程",
    "- 网页浏览：访问网站、点击元素、填写表单",
    "- 代码执行：运行 Python 脚本",
    "- 任务管理：创建待办事项、设置定时任务",
    "- 技能调用：处理特定领域任务",
    "",
    "当前信息：",
    `- 版本：oh-my-wechat v${version}`,
    `- Agent：${mode} agent`,
    `- 目录：${cwd}`,
    "",
    helpText(),
    "",
    "直接发送普通消息，我就会开始处理。",
  ].join("\n");
}

function formatEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "approval":
      return [
        "需要确认操作",
        `审批编号：${event.ticket.id}`,
        "",
        event.ticket.summary,
        "",
        "执行内容：",
        event.ticket.preview,
        "",
        "快捷回复：",
        "同意：y / 1 / 同意",
        "拒绝：n / 0 / 拒绝",
      ].join("\n");
    case "failed":
      return `任务失败：${event.message}`;
    default:
      return null;
  }
}

function statusText(agent: Agent, wire: WechatWire): string {
  const state = agent.state();
  return humanStatus([
    `oh-my-wechat ${state.mode}`,
    `cwd: ${state.cwd}`,
    `command: ${state.command}`,
    `status: ${state.status}`,
    state.pid ? `pid: ${state.pid}` : "",
    state.lastInputAt ? `last_input: ${state.lastInputAt}` : "",
    state.lastOutputAt ? `last_output: ${state.lastOutputAt}` : "",
    state.pendingApproval ? `pending_approval: ${state.pendingApproval.id}` : "",
    "",
    wire.statusText(),
  ]);
}

async function answerControl(
  text: string,
  senderId: string,
  agent: Agent,
  wire: WechatWire,
): Promise<boolean> {
  const trimmed = text.trim();
  const [command] = trimmed.split(/\s+/, 1);
  switch (command?.toLowerCase()) {
    case "/help":
    case "/h":
      await wire.sendText(helpText(), senderId);
      return true;
    case "/status":
      await wire.sendText(statusText(agent, wire), senderId);
      return true;
    case "/stop": {
      const stopped = await agent.stop();
      await wire.sendText(stopped ? "已发送中断。" : "当前没有正在运行的任务。", senderId);
      return true;
    }
    case "/reset":
    case "/new":
      await agent.reset();
      await wire.sendText("本地 CLI 已重启。", senderId);
      return true;
    case "/yes":
    case "/confirm":
    case "y":
    case "1":
    case "同意": {
      const ok = await agent.approve(true);
      await wire.sendText(ok ? "已同意。" : "当前没有待确认操作。", senderId);
      return true;
    }
    case "/no":
    case "/deny":
    case "n":
    case "0":
    case "拒绝": {
      const ok = await agent.approve(false);
      await wire.sendText(ok ? "已拒绝。" : "当前没有待确认操作。", senderId);
      return true;
    }
    default:
      return false;
  }
}

export async function runBridge(options: BridgeOptions): Promise<void> {
  await killOtherBridges(process.pid);
  await acquireBridgeLock({
    pid: process.pid,
    mode: options.mode,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
  }, {
    replaceExisting: true,
  });

  let agent: Agent | null = null;
  let shuttingDown = false;
  let exitCode = 0;

  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await agent?.close();
    } finally {
      if (options.mode === "codex") {
        clearCodexRuntimeEndpoint(options.cwd);
      }
      releaseBridgeLock(process.pid);
    }
  };

  const requestShutdown = async (code: number) => {
    exitCode = code;
    await cleanup();
  };

  process.once("SIGINT", () => {
    void requestShutdown(130).then(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void requestShutdown(143).then(() => process.exit(143));
  });

  try {
    await ensureLogin({ log });
    const wire = new WechatWire(log, options.cwd);
    const runtimeAgent: Agent = options.mode === "codex"
      ? new CodexRuntimeAgent(options)
      : options.mode === "claude"
        ? new ClaudePrintAgent(options)
        : options.mode === "opencode"
          ? new OpenCodeAgent(options)
          : new TerminalAgent(options);
    agent = runtimeAgent;
    let lastRecipient: string | undefined;
    let sending = Promise.resolve();
    let draining = false;
    let localOutputBuffer = "";
    let localOutputTimer: NodeJS.Timeout | null = null;
    const pendingBySender = new Map<string, PendingWechatMessage[]>();

    const printLocalOutput = (text: string) => {
      const normalized = cleanTerminalText(text);
      if (!normalized.trim()) {
        return;
      }
      const rendered = normalized
        .trimEnd()
        .split("\n")
        .map((line) => formatLocalLine(line, "agent", options.mode))
        .join("\n");
      process.stderr.write(`${rendered}\n`);
    };

    const flushLocalOutput = () => {
      if (localOutputTimer) {
        clearTimeout(localOutputTimer);
        localOutputTimer = null;
      }
      const text = localOutputBuffer;
      localOutputBuffer = "";
      if (!text.trim()) {
        return;
      }
      printLocalOutput(text);
    };

    const scheduleLocalOutput = (chunk: string) => {
      const text = cleanTerminalText(chunk);
      if (!text) {
        return;
      }
      localOutputBuffer += text;
      if (localOutputTimer) {
        clearTimeout(localOutputTimer);
      }
      localOutputTimer = setTimeout(flushLocalOutput, 300);
    };

    const enqueueSend = (work: () => Promise<void>) => {
      sending = sending.then(work, work);
    };

    const isAgentBusy = () => {
      const state = runtimeAgent.state();
      return state.status === "busy" || state.status === "awaiting_approval";
    };

    const enqueueUserMessage = (message: PendingWechatMessage) => {
      const queue = pendingBySender.get(message.senderId) ?? [];
      queue.push(message);
      pendingBySender.set(message.senderId, queue);
    };

    const shiftNextMessage = (): PendingWechatMessage | null => {
      for (const [senderId, queue] of pendingBySender.entries()) {
        const next = queue.shift();
        if (queue.length === 0) {
          pendingBySender.delete(senderId);
        }
        if (next) {
          return next;
        }
      }
      return null;
    };

    const flushPendingMessages = async () => {
      if (draining || shuttingDown) {
        return;
      }
      draining = true;
      try {
        while (!shuttingDown && !isAgentBusy()) {
          const next = shiftNextMessage();
          if (!next) {
            return;
          }
          lastRecipient = next.senderId;
          try {
            await runtimeAgent.send(
              options.mode === "shell"
                ? next.text
                : promptForWechat(next.text, options.cwd, next.attachments),
            );
          } catch (error) {
            await wire.sendText(error instanceof Error ? error.message : String(error), next.senderId);
            if (isAgentBusy()) {
              return;
            }
          }
        }
      } finally {
        draining = false;
      }
    };
    runtimeAgent.onEvent((event) => {
      if (shuttingDown) {
        return;
      }
      const direct = formatEvent(event);
      if (direct && lastRecipient) {
        enqueueSend(() => wire.sendText(direct, lastRecipient).then(() => undefined));
        return;
      }
      if (event.type === "status" && event.status === "idle") {
        flushLocalOutput();
        void flushPendingMessages();
      }
      if (event.type === "output") {
        scheduleLocalOutput(event.text);
        return;
      }
      if (event.type !== "final" || !lastRecipient) {
        return;
      }
      const parsed = parseAttachments(event.text);
      const visibleText = parsed.files.length > 0 ? minimizeAttachmentReply(parsed.visible) : parsed.visible;
      flushLocalOutput();
      enqueueSend(async () => {
        if (visibleText) {
          await wire.sendText(visibleText, lastRecipient);
        }
        for (const filePath of parsed.files) {
          await wire.sendFile(filePath, lastRecipient, classifyAttachment(filePath));
        }
      });
    });

    await runtimeAgent.start();
    if (options.mode === "codex" && runtimeAgent instanceof CodexRuntimeAgent) {
      const remote = runtimeAgent.getRemoteEndpoint();
      writeCodexRuntimeEndpoint({
        cwd: options.cwd,
        command: remote.command,
        url: remote.url,
        tokenEnv: remote.tokenEnv,
        token: remote.token,
        bridgePid: process.pid,
        ...(typeof remote.serverPid === "number" ? { serverPid: remote.serverPid } : {}),
        startedAt: new Date().toISOString(),
      });
    }
    await wire.sendText(bridgeOnlineText(options.mode, options.cwd, PKG.version)).catch(() => undefined);

    log(`Bridge online in ${options.cwd}; mode=${options.mode}`);
    const startedAt = Date.now();
    let failures = 0;

    while (!shuttingDown) {
      try {
        const { messages, ignored } = await wire.poll(35_000, startedAt - 2_000);
        if (ignored) {
          log(`Ignored ${ignored} older message(s).`);
        }
        failures = 0;
        for (const message of messages) {
          if (shuttingDown) {
            break;
          }
          lastRecipient = message.senderId;
          if (await answerControl(message.text, message.senderId, runtimeAgent, wire)) {
            continue;
          }
          log(`From ${message.senderName}: ${preview(message.text, 120)}`, "user");
          enqueueUserMessage({
            senderId: message.senderId,
            senderName: message.senderName,
            text: message.text,
            attachments: message.attachments,
          });
          await flushPendingMessages();
        }
      } catch (error) {
        if (shuttingDown) {
          break;
        }
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        log(`poll failed: ${message}`);
        const delay = Math.min(POLL_RETRY_MAX, POLL_RETRY_MIN * 2 ** Math.min(failures, 5));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    await cleanup();
    if (exitCode !== 0 && process.exitCode == null) {
      process.exitCode = exitCode;
    }
  }
}

export async function runBridgeCli(): Promise<void> {
  await runBridge(parseArgs(process.argv.slice(2)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBridgeCli().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
