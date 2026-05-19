#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildUpgradeHint, fetchLatestVersion, readLocalPackageInfo } from "./version.js";
const PKG = readLocalPackageInfo();
const BRIDGE_MODES = ["codex", "claude", "opencode", "shell"];
function globalUsage() {
    return [
        `oh-my-wechat v${PKG.version}`,
        "",
        "Usage:",
        "  omw <command> [options]",
        "",
        "Commands:",
        "  setup         登录或重新登录微信账号",
        "                用法: omw setup [--force]",
        "",
        "  bridge        以显式 mode 启动 bridge",
        `                用法: omw bridge --mode <${BRIDGE_MODES.join("|")}> [--cwd <dir>] [--command <cmd>] [args...]`,
        "",
        "  codex         启动 Codex bridge",
        "                用法: omw codex [--cwd <dir>] [--command <cmd>] [args...]",
        "",
        "  claude        启动 Claude Code bridge",
        "                用法: omw claude [--cwd <dir>] [--command <cmd>] [args...]",
        "",
        "  opencode      启动 OpenCode bridge",
        "                用法: omw opencode [--cwd <dir>] [--command <cmd>] [args...]",
        "",
        "  shell         启动 shell bridge",
        "                用法: omw shell [--cwd <dir>] [--command <cmd>] [args...]",
        "",
        "  check-update  检查本地版本与 npm 最新版本",
        "                用法: omw check-update",
        "",
        "Common options:",
        "  -h, --help       显示帮助",
        "  --cwd <dir>      指定 bridge 工作目录",
        "  --command <cmd>  覆盖默认本地 agent 启动命令",
        "  --force          setup 时强制重新登录",
        "  --mode <mode>    bridge 模式，仅 bridge 子命令使用",
        "  --adapter <mode> --mode 的别名",
        "",
        "Examples:",
        "  omw setup --force",
        "  omw codex --cwd ~/work/project",
        "  omw claude --command claude-code",
        "  omw bridge --mode shell --cwd ~/work/project",
        "  omw check-update",
        "",
        "Run 'omw <command> --help' for command-specific help.",
        "",
    ].join("\n");
}
function commandUsage(subcommand) {
    switch (subcommand) {
        case "setup":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw setup [--force] [--qr-small|--qr-large]",
                "",
                "Description:",
                "  登录或重新登录微信账号，并保存 bridge 所需凭证。",
                "",
                "Options:",
                "  --force       强制重新登录微信账号",
                "  --qr-small    强制使用紧凑二维码输出",
                "  --qr-large    强制使用标准大二维码输出",
                "  -h, --help    显示帮助",
                "",
                "Examples:",
                "  omw setup",
                "  omw setup --force",
                "  omw setup --qr-large",
                "",
            ].join("\n");
        case "bridge":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                `  omw bridge --mode <${BRIDGE_MODES.join("|")}> [--cwd <dir>] [--command <cmd>] [args...]`,
                "",
                "Description:",
                "  以显式 mode 启动 bridge，适合脚本或手动指定运行模式。",
                "",
                "Options:",
                "  --mode <mode>       指定 bridge 模式",
                "  --adapter <mode>    --mode 的别名",
                "  --cwd <dir>         指定工作目录，默认当前目录",
                "  --command <cmd>     覆盖默认本地 agent 启动命令",
                "  -h, --help          显示帮助",
                "",
                "Notes:",
                "  其余参数会继续透传给对应本地 agent。",
                "",
                "Examples:",
                "  omw bridge --mode codex",
                "  omw bridge --mode shell --cwd ~/work/project",
                "  omw bridge --mode claude --command claude-code",
                "",
            ].join("\n");
        case "codex":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw codex [--cwd <dir>] [--command <cmd>] [args...]",
                "",
                "Description:",
                "  启动 Codex bridge，默认本地命令为 codex。",
                "",
                "Options:",
                "  --cwd <dir>       指定工作目录，默认当前目录",
                "  --command <cmd>   覆盖默认本地 agent 启动命令",
                "  -h, --help        显示帮助",
                "",
                "Notes:",
                "  等价于 omw bridge --mode codex ...",
                "  其余参数会继续透传给 Codex。",
                "",
                "Examples:",
                "  omw codex",
                "  omw codex --cwd ~/work/project",
                "  omw codex --command codex-beta",
                "",
            ].join("\n");
        case "claude":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw claude [--cwd <dir>] [--command <cmd>] [args...]",
                "",
                "Description:",
                "  启动 Claude Code bridge，默认本地命令为 claude。",
                "",
                "Options:",
                "  --cwd <dir>       指定工作目录，默认当前目录",
                "  --command <cmd>   覆盖默认本地 agent 启动命令",
                "  -h, --help        显示帮助",
                "",
                "Notes:",
                "  等价于 omw bridge --mode claude ...",
                "  其余参数会继续透传给 Claude Code。",
                "",
                "Examples:",
                "  omw claude",
                "  omw claude --cwd ~/work/project",
                "  omw claude --command claude-code",
                "",
            ].join("\n");
        case "opencode":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw opencode [--cwd <dir>] [--command <cmd>] [args...]",
                "",
                "Description:",
                "  启动 OpenCode bridge，默认本地命令为 opencode。",
                "",
                "Options:",
                "  --cwd <dir>       指定工作目录，默认当前目录",
                "  --command <cmd>   覆盖默认本地 agent 启动命令",
                "  -h, --help        显示帮助",
                "",
                "Notes:",
                "  等价于 omw bridge --mode opencode ...",
                "  其余参数会继续透传给 OpenCode。",
                "",
                "Examples:",
                "  omw opencode",
                "  omw opencode --cwd ~/work/project",
                "  omw opencode --command opencode-nightly",
                "",
            ].join("\n");
        case "shell":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw shell [--cwd <dir>] [--command <cmd>] [args...]",
                "",
                "Description:",
                "  启动 shell bridge，默认本地命令为当前 SHELL 或 bash。",
                "",
                "Options:",
                "  --cwd <dir>       指定工作目录，默认当前目录",
                "  --command <cmd>   覆盖默认 shell 命令",
                "  -h, --help        显示帮助",
                "",
                "Notes:",
                "  等价于 omw bridge --mode shell ...",
                "  其余参数会继续透传给 shell。",
                "",
                "Examples:",
                "  omw shell",
                "  omw shell --cwd ~/work/project",
                "  omw shell --command zsh",
                "",
            ].join("\n");
        case "check-update":
            return [
                `oh-my-wechat v${PKG.version}`,
                "",
                "Usage:",
                "  omw check-update",
                "",
                "Description:",
                "  检查当前本地版本与 npm 上 latest 版本，并给出升级状态。",
                "",
                "Output:",
                "  name      包名",
                "  local     当前本地版本",
                "  latest    npm 上最新版本",
                "  status    up to date / update available / latest unknown / not published",
                "",
            ].join("\n");
        default:
            return globalUsage();
    }
}
function printHelp(subcommand) {
    process.stdout.write(subcommand ? commandUsage(subcommand) : globalUsage());
}
function hasHelpFlag(args) {
    return args.includes("--help") || args.includes("-h");
}
function binPath(name) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", name);
}
function shouldAutoCheck(subcommand) {
    return subcommand !== "check-update";
}
async function notifyIfUpdateAvailable() {
    const latestResult = await fetchLatestVersion(PKG.name, { timeoutMs: 1_500 });
    if (latestResult.status !== "ok") {
        return;
    }
    const hint = buildUpgradeHint(PKG.name, PKG.version, latestResult.latestVersion);
    if (!hint) {
        return;
    }
    process.stderr.write(`${hint}\n`);
}
const [subcommand, ...rest] = process.argv.slice(2);
const map = {
    setup: "omw-setup.mjs",
    bridge: "omw-bridge.mjs",
    codex: "omw-codex.mjs",
    claude: "omw-claude.mjs",
    opencode: "omw-opencode.mjs",
    shell: "omw-shell.mjs",
    "check-update": "omw-check-update.mjs",
};
if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    process.exit(0);
}
const bin = map[subcommand];
if (!bin) {
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}
if (hasHelpFlag(rest)) {
    printHelp(subcommand);
    process.exit(0);
}
process.stderr.write(`${PKG.name} v${PKG.version}\n`);
if (shouldAutoCheck(subcommand)) {
    void notifyIfUpdateAvailable();
}
const child = spawn(process.execPath, [binPath(bin), ...rest], {
    stdio: "inherit",
});
child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});
//# sourceMappingURL=main.js.map