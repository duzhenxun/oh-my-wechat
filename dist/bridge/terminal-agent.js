import os from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { cleanTerminalText, defaultCommand, interactiveShellCommand, now, preview, riskyShellCommand, splitCommand, } from "./text.js";
export class TerminalAgent {
    options;
    pty = null;
    child = null;
    sink = () => undefined;
    stateValue;
    outputBuffer = "";
    flushTimer = null;
    pendingCommand = null;
    closing = false;
    constructor(options) {
        this.options = options;
        this.stateValue = {
            mode: options.mode,
            command: options.command || defaultCommand(options.mode),
            cwd: options.cwd,
            status: "stopped",
        };
    }
    onEvent(sink) {
        this.sink = sink;
    }
    async start() {
        if (this.pty || this.child) {
            return;
        }
        this.closing = false;
        this.setStatus("starting", `Starting ${this.stateValue.mode}: ${this.stateValue.command}`);
        const target = splitCommand(this.stateValue.command);
        const args = [...target.args, ...(this.options.args ?? [])];
        const env = {
            ...process.env,
            TERM: "xterm-256color",
            OH_MY_WECHAT: "1",
        };
        try {
            const spawnPty = await loadPtySpawner();
            this.pty = spawnPty(target.file, args, {
                name: "xterm-256color",
                cols: Number(process.env.OH_MY_WECHAT_COLS || 120),
                rows: Number(process.env.OH_MY_WECHAT_ROWS || 30),
                cwd: this.options.cwd,
                env,
            });
            this.stateValue.pid = this.pty.pid;
            this.pty.onData((data) => this.handleData(data));
            this.pty.onExit(({ exitCode }) => this.handleExit(exitCode));
        }
        catch (error) {
            this.sink({
                type: "output",
                stream: "stderr",
                text: `PTY startup failed, falling back to plain process mode: ${error instanceof Error ? error.message : String(error)}\n`,
                at: now(),
            });
            const fallback = this.stateValue.mode === "shell"
                ? { file: target.file, args }
                : buildFallbackSpawn(target.file, args);
            this.child = spawnChild(fallback.file, fallback.args, {
                cwd: this.options.cwd,
                env,
                stdio: "pipe",
            });
            if (typeof this.child.pid === "number") {
                this.stateValue.pid = this.child.pid;
            }
            this.child.stdout.on("data", (data) => this.handleData(data.toString("utf8")));
            this.child.stderr.on("data", (data) => this.handleData(data.toString("utf8")));
            this.child.on("exit", (exitCode) => this.handleExit(exitCode ?? undefined));
            this.child.on("error", (childError) => {
                this.sink({
                    type: "failed",
                    message: childError.message,
                    at: now(),
                });
            });
        }
        this.stateValue.startedAt = now();
        if (this.stateValue.mode === "shell") {
            this.primeShell();
        }
        this.setStatus("idle", `${this.stateValue.mode} is ready.`);
    }
    async send(text) {
        if (!this.pty && !this.child) {
            throw new Error(`${this.stateValue.mode} is not running.`);
        }
        if (this.stateValue.status === "awaiting_approval") {
            throw new Error("An approval is pending. Reply /yes or /no.");
        }
        const payload = text.trim();
        if (!payload) {
            return;
        }
        if (this.stateValue.mode === "shell") {
            const blocked = interactiveShellCommand(payload);
            if (blocked) {
                throw new Error(blocked);
            }
            if (riskyShellCommand(payload)) {
                const ticket = {
                    id: cryptoRandomCode(),
                    summary: "High-risk shell command requires confirmation.",
                    preview: preview(payload),
                    createdAt: now(),
                };
                this.pendingCommand = payload;
                this.stateValue.pendingApproval = ticket;
                this.setStatus("awaiting_approval", "Waiting for WeChat approval.");
                this.sink({ type: "approval", ticket, at: now() });
                return;
            }
        }
        this.writePayload(payload);
    }
    async stop() {
        if (!this.pty && !this.child) {
            return false;
        }
        if (this.pty) {
            this.pty.write("\u0003");
        }
        else {
            this.child?.kill("SIGINT");
        }
        this.setStatus("idle", "已发送中断。");
        return true;
    }
    async approve(yes) {
        if (!this.stateValue.pendingApproval) {
            return false;
        }
        const command = this.pendingCommand;
        this.pendingCommand = null;
        this.stateValue.pendingApproval = null;
        if (!yes || !command) {
            this.setStatus("idle", "已拒绝确认操作。");
            return true;
        }
        this.writePayload(command);
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
        this.closing = true;
        this.clearFlushTimer();
        if (!this.pty && !this.child) {
            return;
        }
        const pty = this.pty;
        const child = this.child;
        this.pty = null;
        this.child = null;
        pty?.kill();
        child?.kill();
        this.setStatus("stopped", "Closed.");
    }
    writePayload(text) {
        if (!this.pty && !this.child) {
            throw new Error(`${this.stateValue.mode} is not running.`);
        }
        this.stateValue.lastInputAt = now();
        this.setStatus("busy");
        const value = this.stateValue.mode === "shell" ? shellWrapped(text) : `${text}\n`;
        this.writeRaw(value);
    }
    handleData(raw) {
        const text = cleanTerminalText(raw);
        if (!text.trim()) {
            return;
        }
        this.stateValue.lastOutputAt = now();
        this.outputBuffer += text;
        this.sink({ type: "output", stream: "stdout", text, at: now() });
        this.scheduleFlush();
    }
    scheduleFlush() {
        this.clearFlushTimer();
        this.flushTimer = setTimeout(() => this.flushOutput(), 900);
    }
    flushOutput(force = false) {
        this.clearFlushTimer();
        const text = this.outputBuffer.trim();
        this.outputBuffer = "";
        if (!text) {
            return;
        }
        if (force || this.stateValue.status === "busy") {
            this.setStatus("idle");
        }
        this.sink({ type: "final", text: text.slice(-3500), at: now() });
    }
    clearFlushTimer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }
    setStatus(status, message) {
        this.stateValue.status = status;
        this.sink({ type: "status", status, ...(message ? { message } : {}), at: now() });
    }
    primeShell() {
        if (process.platform === "win32") {
            this.writeRaw('function global:prompt { "" }\r');
        }
        else if (os.platform() !== "win32") {
            this.writeRaw("export PS1=''\n");
        }
    }
    writeRaw(value) {
        if (this.pty) {
            this.pty.write(value);
            return;
        }
        this.child?.stdin.write(value);
    }
    handleExit(exitCode) {
        this.flushOutput(true);
        this.pty = null;
        this.child = null;
        delete this.stateValue.pid;
        if (this.closing) {
            return;
        }
        this.setStatus(exitCode === 0 ? "stopped" : "error", `${this.stateValue.mode} exited with code ${exitCode}`);
    }
}
function cryptoRandomCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function shellWrapped(command) {
    if (process.platform === "win32") {
        const encoded = Buffer.from(command, "utf16le").toString("base64");
        return `powershell -NoProfile -EncodedCommand ${encoded}\r`;
    }
    return `${command}\n`;
}
function buildFallbackSpawn(file, args) {
    if (process.platform === "darwin") {
        return {
            file: "/usr/bin/script",
            args: ["-q", "/dev/null", file, ...args],
        };
    }
    return { file, args };
}
async function loadPtySpawner() {
    const mod = (await import("node-pty"));
    if (typeof mod.spawn !== "function") {
        throw new Error("node-pty did not expose spawn().");
    }
    return mod.spawn;
}
//# sourceMappingURL=terminal-agent.js.map