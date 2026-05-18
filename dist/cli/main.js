#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
function usage() {
    return [
        "oh-my-wechat",
        "",
        "Usage:",
        "  omw setup",
        "  omw codex [args]",
        "  omw claude [args]",
        "  omw opencode [args]",
        "  omw shell",
        "  omw bridge --mode <mode>",
        "  omw check-update",
        "",
    ].join("\n");
}
function binPath(name) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", name);
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
    process.stdout.write(usage());
    process.exit(0);
}
const bin = map[subcommand];
if (!bin) {
    console.error(`Unknown command: ${subcommand}\n`);
    process.stdout.write(usage());
    process.exit(1);
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